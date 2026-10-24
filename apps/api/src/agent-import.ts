import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { SecretStore } from "@rakazo/adapter-kit";
import type { AgentImportSettings, ImportedMcpServer } from "@rakazo/adapters";
import {
  BUILTIN_AGENT_SKILLS,
  isCatalogModelChoice,
  readAgentImportSettings,
} from "@rakazo/adapters";
import type {
  Actor,
  AgentImportCreateInput,
  AgentImportErrorReason,
  AgentImportFile,
  AgentImportInfo,
  AgentImportMemoryDestination,
  AgentImportPlan,
  AgentImportSetupItem,
  AgentImportSetupState,
  AgentImportSource,
  AgentImportWarning,
  Bot,
  CreateRoutineInput as CreateRoutineInputType,
  McpServerConfigInput,
} from "@rakazo/contracts";
import {
  BOT_INSTRUCTIONS_MAX_LENGTH,
  CreateRoutineInput,
  isValidTimeZone,
  MEMORY_INDEX_PATH,
  MessageBlock as MessageBlockSchema,
} from "@rakazo/contracts";
import type { SkillFiles } from "@rakazo/core";
import {
  combineImportedInstructions,
  freeAgentImportMemoryPath,
  parseAgentImport,
  readAgentImportFolder,
  resolveAgentImportNames,
} from "@rakazo/core";
import type { McpServer as McpServerRow, Prisma, PrismaClient, Routine } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  InstructionConflictError,
  IsolationError,
  writeBotInstructions,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

type Reader = Pick<Prisma.TransactionClient, "memoryDocument" | "agentSkill" | "mcpServer">;
type Stored = Awaited<ReturnType<SecretStore["put"]>> | null;

/**
 * The existing paths an import writes through, built by the router so each setting is
 * validated, encrypted and scheduled exactly as when the user adds it by hand. Checks and
 * encryption run before the import's single transaction; the writes run inside it.
 */
export type AgentImportServices<PreparedKey = unknown> = {
  prisma: PrismaClient;
  createBot: (
    actor: Actor,
    input: {
      name: string;
      title: string;
      description: string;
      instructions: string;
      notifyOnFinish: boolean;
      computerMode: AgentImportCreateInput["computerMode"];
      modelProvider: string | null;
      modelId: string | null;
      spawnKey?: string;
      seed: (tx: Prisma.TransactionClient, botId: string) => Promise<void>;
    },
  ) => Promise<Bot>;
  hasModelConnection: (actor: Actor, provider: string) => Promise<boolean>;
  /**
   * The header and env values stored for an MCP server's credential, decrypted on the server
   * only to tell set from blank; never returned to a client. Null when there is none.
   */
  mcpCredentialValues: (
    actor: Actor,
    server: { id: string; secretId: string },
  ) => Promise<{ headers: Record<string, string>; env: Record<string, string> } | null>;
  /** Which of these providers the actor has a connection for, read once. */
  connectedProviders: (actor: Actor, providers: string[]) => Promise<Set<string>>;
  /** `bots.update`'s model check; an error message or null. */
  validateBotModel: (actor: Actor, provider: string, modelId: string) => Promise<string | null>;
  /** Whether this deployment can launch a stdio MCP command. */
  stdioAllowed: (command: string) => boolean;
  /** `models.connect`'s checks and encryption for a key, without writing it. */
  prepareModelKey: (
    actor: Actor,
    input: { provider: string; apiKey: string; modelId?: string },
    signal?: AbortSignal,
  ) => Promise<PreparedKey>;
  /**
   * `models.connect`'s writes, keeping the space's existing default model. Create-only:
   * null, and nothing written, when the provider is already connected.
   */
  writeModelKey: (
    tx: Prisma.TransactionClient,
    actor: Actor,
    prepared: PreparedKey,
  ) => Promise<{ id: string; secretId: string; provider: string } | null>;
  afterModelKey: (provider: string) => void;
  prepareMcpServer: (actor: Actor, input: McpServerConfigInput) => Promise<Stored>;
  insertMcpServer: (
    tx: Prisma.TransactionClient,
    actor: Actor,
    input: McpServerConfigInput,
    stored: Stored,
  ) => Promise<McpServerRow>;
  /**
   * A serializable transaction, retried on conflict, for an import into an existing bot
   * (a new bot's import runs inside `createBot`, serializable too).
   */
  inTransaction: <T>(run: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;
  /** The actor's bot as `bots.get` returns it, or null. */
  findBot: (actor: Actor, botId: string) => Promise<Bot | null>;
  assertRoutineSchedule: (input: CreateRoutineInputType) => void;
  routineNextRunAt: (input: CreateRoutineInputType) => Date | null;
  routineRowData: (
    actor: Actor,
    input: CreateRoutineInputType,
    nextRunAt: Date | null,
  ) => Prisma.RoutineUncheckedCreateInput;
  announceRoutine: (
    actor: Actor,
    bot: { id: string; thread: { id: string } | null },
    row: Routine,
  ) => Promise<void>;
  /** `bots.remove`, with more removals inside its deletion transaction. */
  destroyBot: (
    actor: Actor,
    botId: string,
    options: {
      deleteMemories: boolean;
      within: (tx: Prisma.TransactionClient) => Promise<{ deleteMemories: boolean } | undefined>;
    },
  ) => Promise<void>;
  /** `mcp.servers.remove`'s writes; returns the chat events its closed cards appended. */
  removeMcpServer: (
    tx: Prisma.TransactionClient,
    actor: Actor,
    server: { id: string; secretId: string | null },
  ) => Promise<{ threadId: string; seq: number }[]>;
  /** Tells open chats about an event, once its transaction committed. */
  notifyThread: (threadId: string, seq: number) => Promise<void>;
};

/**
 * What an import created and how it looked then, kept on its record so Undo removes only
 * what the user has not changed since.
 */
type ImportRecord = {
  skills: { id: string; hash: string }[];
  spaceMemory: { id: string; revision: number }[];
  botMemory: { id: string; revision: number }[];
  /**
   * `credentials`/`env`: names that need values before the server works (its checklist);
   * `unverifiable`: it also needs a program or local paths, which cannot be checked.
   */
  mcpServers: {
    id: string;
    revision: number;
    credentials?: string[];
    env?: string[];
    unverifiable?: boolean;
  }[];
  routines: { id: string; updatedAt?: string }[];
  credentials: { id: string; secretId: string; provider: string }[];
  /** Added to a bot that existed before: Undo removes what was added, never the bot. */
  existingBot?: boolean;
  /** The checklist message this import posted, retired by Undo. */
  setupMessageId?: string;
  /** When the import replaced that bot's instructions: the history entry with the old ones. */
  instructions?: { versionId: string; imported: string };
  /** When the import set that bot's model: the one it had before, and the one set. */
  model?: {
    previous: { provider: string | null; modelId: string | null };
    imported: { provider: string; modelId: string };
  };
};

/** Warnings that mean the item cannot work at all here. */
const BLOCKING: ReadonlySet<AgentImportWarning> = new Set(["unsupported_command"]);

function parsePlan(files: AgentImportFile[], skillFiles: SkillFiles): AgentImportPlan {
  const plan = parseAgentImport(files, skillFiles);
  if ("error" in plan) throw new ORPCError("BAD_REQUEST", { message: plan.error });
  return plan;
}

/** Names this actor already uses; imports never overwrite them. */
async function takenNames(db: Reader, actor: Actor) {
  const owner = { spaceId: actor.spaceId, userId: actor.userId };
  const documents = await db.memoryDocument.findMany({
    where: { ...owner, scope: "user", botId: null },
    select: { path: true },
  });
  const skills = await db.agentSkill.findMany({ where: owner, select: { name: true } });
  const servers = await db.mcpServer.findMany({ where: owner, select: { slug: true } });
  return {
    spaceMemoryPaths: documents.map((document) => document.path),
    skillNames: [...skills, ...BUILTIN_AGENT_SKILLS].map((skill) => skill.name),
    mcpSlugs: servers.map((server) => server.slug),
  };
}

type Built = {
  plan: AgentImportPlan;
  settings: (AgentImportSettings & { keyValues: Map<string, string> }) | null;
  routineInputs: Map<string, CreateRoutineInputType>;
  mcpConfigs: Map<string, ImportedMcpServer & { slug: string }>;
  /** Key ids skipped because their provider is connected (since the preview, perhaps). */
  connectedKeyIds: Set<string>;
};

/**
 * The plan for these files against the actor's data. Settings come from the source's
 * config files; key values stay in `settings.keyValues` and never enter the plan.
 */
async function buildPlan(
  services: AgentImportServices,
  actor: Actor,
  input: { files: AgentImportFile[]; includeSecrets: boolean; skillFiles: SkillFiles },
): Promise<Built> {
  const { files, includeSecrets } = input;
  const base = parsePlan(files, input.skillFiles);
  const taken = await takenNames(services.prisma, actor);
  const plan = resolveAgentImportNames(base, taken);
  const folder =
    base.source === "document" ? null : readAgentImportFolder(files, { includeSecrets });
  const routineInputs = new Map<string, CreateRoutineInputType>();
  const mcpConfigs = new Map<string, ImportedMcpServer & { slug: string }>();
  // Keys whose provider is connected now: never imported, and fine to still be selected.
  const connectedKeyIds = new Set<string>();
  if (!folder) return { plan, settings: null, routineInputs, mcpConfigs, connectedKeyIds };
  const settings = readAgentImportSettings(folder, {
    includeSecrets,
    stdioAllowed: services.stdioAllowed,
  });

  let model: AgentImportPlan["model"] = null;
  if (settings.model) {
    const { title, provider, providerName, modelId, known } = settings.model;
    // Usable means what `bots.update` would accept for this actor now: a connection for
    // that provider (or the deployment's hosted credits) and a model it can call.
    const usable = (await services.validateBotModel(actor, provider, modelId)) === null;
    const status = usable ? "ready" : known ? "needs_key" : "unknown";
    model = { id: "model", title, provider, providerName, modelId, status };
  }

  const skipped = [...plan.skipped, ...settings.skipped];
  const apiKeys: AgentImportPlan["apiKeys"] = [];
  for (const key of settings.apiKeys) {
    // An existing connection is never replaced by an import.
    if (await services.hasModelConnection(actor, key.provider)) {
      skipped.push({ path: key.source, reason: "connected" });
      connectedKeyIds.add(key.id);
    } else {
      apiKeys.push({ id: key.id, title: key.title, provider: key.provider });
    }
  }

  const slugs = new Set(taken.mcpSlugs);
  const mcpServers = settings.mcpServers.map((server) => {
    const slug = freeSlug(server.config.slug, slugs);
    mcpConfigs.set(server.id, { ...server, slug });
    return {
      id: server.id,
      title: server.title,
      name: slug,
      content: server.content,
      warnings: server.warnings,
      status: server.status,
    };
  });

  const saved = (
    await services.prisma.user.findUnique({
      where: { id: actor.userId },
      select: { timezone: true },
    })
  )?.timezone;
  const fallbackZone = saved && isValidTimeZone(saved) ? saved : "UTC";
  const routines = settings.routines.flatMap((routine) => {
    const timezone = routine.timezone ?? fallbackZone;
    const parsed = CreateRoutineInput.safeParse({
      // Replaced by the new bot's id when the routine is written.
      botId: "pending",
      name: routine.name,
      prompt: routine.prompt,
      crons: [routine.cron],
      timezone,
      // Paused, like every new routine: the user turns it on.
      active: false,
    });
    if (!parsed.success) {
      skipped.push({ path: `cron/jobs.json: ${routine.title}`, reason: "unsupported" });
      return [];
    }
    routineInputs.set(routine.id, parsed.data);
    return [
      {
        id: routine.id,
        title: routine.title,
        content: `${routine.cron} (${timezone})\n\n${routine.prompt}`,
        warnings: routine.warnings,
        // Created paused: it runs once the user turns it on.
        status: { kind: "needs_setup" as const, needs: [{ kind: "turn_on" as const }] },
      },
    ];
  });

  return {
    plan: { ...plan, model, mcpServers, routines, apiKeys, skipped },
    settings,
    routineInputs,
    mcpConfigs,
    connectedKeyIds,
  };
}

export async function previewAgentImport(
  services: AgentImportServices,
  actor: Actor,
  input: { files: AgentImportFile[]; includeSecrets: boolean; skillFiles: SkillFiles },
): Promise<AgentImportPlan> {
  return (await buildPlan(services, actor, input)).plan;
}

/** Items of `items` whose ids were selected, in plan order; unknown or repeated ids fail. */
function selected<
  T extends { id: string; warnings?: AgentImportWarning[]; status?: { kind: string } },
>(items: T[], ids: string[]): T[] {
  const known = new Set(items.map((item) => item.id));
  const chosen = new Set(ids);
  if (chosen.size !== ids.length || ids.some((id) => !known.has(id))) {
    throw refused("BAD_REQUEST", "selection_mismatch", "The selection does not match the files.");
  }
  const picked = items.filter((item) => chosen.has(item.id));
  if (picked.some((item) => item.warnings?.some((warning) => BLOCKING.has(warning)))) {
    throw refused("BAD_REQUEST", "cannot_run_here", "That MCP server cannot run here.");
  }
  // Not supported here at all (a skill for another platform): never created.
  if (picked.some((item) => item.status?.kind === "unsupported")) {
    throw refused("BAD_REQUEST", "cannot_run_here", "That item cannot work here.");
  }
  return picked;
}

/**
 * Creates the bot from re-read files (nothing is staged between preview and create). Every
 * check, key verification and encryption runs first; then one transaction writes the keys,
 * bot, memory, skills, MCP servers with their approval cards, routines and the import
 * record. Health checks and routine notices follow; they write nothing the import needs.
 */
export async function createImportedBot<PreparedKey>(
  services: AgentImportServices<PreparedKey>,
  actor: Actor,
  input: AgentImportCreateInput,
  signal?: AbortSignal,
): Promise<Bot> {
  const owner = { spaceId: actor.spaceId, userId: actor.userId };
  const { importKey, ...request } = input;
  const digest = requestDigest(request);
  // A retried create (same import key, same request) returns the bot the first one made.
  const already = async () => {
    if (!importKey) return null;
    const found = await services.prisma.agentImport.findFirst({
      where: { ...owner, importKey },
      select: { botId: true, requestDigest: true },
    });
    if (!found) return null;
    if (found.requestDigest !== digest) {
      throw refused(
        "PRECONDITION_FAILED",
        "import_reused",
        "This import was already used with different files or choices.",
      );
    }
    return services.findBot(actor, found.botId);
  };
  const repeated = await already();
  if (repeated) return repeated;
  const destination = input.destination;
  if (destination.kind === "existing" && input.spawnKey) {
    throw refused("BAD_REQUEST", "first_bot_new_only", "A first bot is always a new bot.");
  }
  if (destination.kind === "new" && !input.name) {
    throw refused("BAD_REQUEST", "name_required", "Name the new bot.");
  }
  // Only the actor's own bot in this space; anything else is not found.
  const target =
    destination.kind === "existing" ? await services.findBot(actor, destination.botId) : null;
  if (destination.kind === "existing" && !target) throw new IsolationError();
  const { plan, settings, routineInputs, mcpConfigs, connectedKeyIds } = await buildPlan(
    services as AgentImportServices,
    actor,
    input,
  );
  const instructions = combineImportedInstructions(
    selected(plan.instructions, input.selection.instructions),
  );
  const writesInstructions =
    input.destination.kind === "new" || input.destination.replaceInstructions;
  if (writesInstructions && instructions.length > BOT_INSTRUCTIONS_MAX_LENGTH) {
    throw refused(
      "BAD_REQUEST",
      "instructions_too_long",
      `Instructions can be at most ${BOT_INSTRUCTIONS_MAX_LENGTH} characters. Import fewer files.`,
    );
  }
  const destinations = new Map<string, AgentImportMemoryDestination>(
    input.selection.memory.map((choice) => [choice.id, choice.destination]),
  );
  const memoryIds = selected(
    plan.memory,
    input.selection.memory.map((choice) => choice.id),
  ).map((item) => item.id);
  const skillIds = selected(plan.skills, input.selection.skills).map((item) => item.id);
  const servers = selected(plan.mcpServers, input.selection.mcpServers).map(
    (item) => mcpConfigs.get(item.id)!,
  );
  const routines = selected(plan.routines, input.selection.routines).map(
    (item) => routineInputs.get(item.id)!,
  );
  // A key whose provider was connected after the preview stays selected in the request; it
  // is skipped like any connected key, and the existing connection is kept.
  // A repeated id is refused first, connected or not.
  if (new Set(input.selection.apiKeys).size !== input.selection.apiKeys.length) {
    throw refused("BAD_REQUEST", "selection_mismatch", "The selection does not match the files.");
  }
  const keys = selected(
    plan.apiKeys,
    input.selection.apiKeys.filter((id) => !connectedKeyIds.has(id)),
  );
  const model = input.selection.model ? plan.model : null;
  if (input.selection.model) {
    const keyed = keys.some((key) => key.provider === model?.provider);
    const usable =
      model?.status === "ready" ||
      (model?.status === "needs_key" &&
        keyed &&
        isCatalogModelChoice(model.provider, model.modelId));
    if (!model || !usable) {
      throw refused("BAD_REQUEST", "model_needs_key", "Connect this model's provider first.");
    }
  }
  for (const routine of routines) {
    services.assertRoutineSchedule(routine);
    services.routineNextRunAt(routine);
  }

  // Checks and encryption, before anything is written. A key for the chosen model's
  // provider is also checked against that model, as a connection made for it would be.
  const preparedKeys: PreparedKey[] = [];
  for (const key of keys) {
    if (await services.hasModelConnection(actor, key.provider)) continue;
    const apiKey = settings?.keyValues.get(key.provider);
    if (!apiKey) continue;
    preparedKeys.push(
      await services
        .prepareModelKey(
          actor,
          {
            provider: key.provider,
            apiKey,
            modelId: model?.provider === key.provider ? model.modelId : undefined,
          },
          signal,
        )
        .catch((error: unknown) => {
          throw keyCheckFailure(error, key.title);
        }),
    );
  }
  const preparedServers: { id: string; config: McpServerConfigInput; stored: Stored }[] = [];
  for (const server of servers) {
    // A server renamed to avoid a clash keeps one name everywhere: its name is the new slug.
    const renamed = server.slug !== server.config.slug;
    const config = {
      ...server.config,
      slug: server.slug,
      ...(renamed ? { name: server.slug } : {}),
    };
    preparedServers.push({
      id: server.id,
      config,
      stored: await services.prepareMcpServer(actor, config),
    });
  }

  const record: ImportRecord = {
    skills: [],
    spaceMemory: [],
    botMemory: [],
    mcpServers: [],
    routines: [],
    credentials: [],
  };
  const routineRows: Routine[] = [];
  const setup: AgentImportSetupItem[] = [];
  // The bot the latest attempt imported into. An attempt can be rolled back (a
  // serialization retry) and a later one may not run the import at all (a first bot made
  // meanwhile). The bot `createBot` returns is the one its committed transaction made, so the
  // import committed exactly when that is the bot the last import attempt wrote into.
  let importedInto: string | null = null;
  /** Every write of the import, in one transaction, into the new or the existing bot. */
  const write = async (tx: Prisma.TransactionClient, botId: string) => {
    // A serialization conflict runs this again: start each attempt clean.
    for (const list of [
      record.skills,
      record.spaceMemory,
      record.botMemory,
      record.mcpServers,
      record.routines,
      record.credentials,
    ]) {
      list.length = 0;
    }
    record.instructions = undefined;
    record.model = undefined;
    routineRows.length = 0;
    setup.length = 0;
    if (target) {
      record.existingBot = true;
      // An existing bot's instructions change only when the user chose to replace them, as a
      // recorded edit the user can restore; its model only when the model was ticked.
      if (destination.kind === "existing" && destination.replaceInstructions && instructions) {
        const versionId = await writeBotInstructions(tx, {
          botId,
          instructions,
          reason: "Agent import",
          expectedInstructions: destination.expectedInstructions,
        });
        if (versionId) record.instructions = { versionId, imported: instructions };
      }
      if (model) {
        const before = await tx.bot.findUniqueOrThrow({
          where: { id: botId },
          select: { modelProvider: true, modelId: true },
        });
        await tx.bot.update({
          where: { id: botId },
          data: { modelProvider: model.provider, modelId: model.modelId },
        });
        record.model = {
          previous: { provider: before.modelProvider, modelId: before.modelId },
          imported: { provider: model.provider, modelId: model.modelId },
        };
      }
    }
    for (const prepared of preparedKeys) {
      // Only keys this import created are recorded; one connected meanwhile stays as is.
      const credential = await services.writeModelKey(tx, actor, prepared);
      if (credential) record.credentials.push(credential);
    }
    // Names are checked again under the creation lock: the preview may be stale.
    const resolved = resolveAgentImportNames(plan, await takenNames(tx, actor));
    // An existing bot's memory is never overwritten: a taken path gets the next free name.
    const botPaths = new Set(
      target
        ? (
            await tx.memoryDocument.findMany({
              where: { ...owner, scope: "bot", botId },
              select: { path: true },
            })
          ).map((row) => row.path.toLowerCase())
        : [],
    );
    const memory = resolved.memory
      .filter((item) => memoryIds.includes(item.id))
      .sort((left, right) => curatedRank(left.path) - curatedRank(right.path));
    // Agent context reads the newest memory first within a size budget, so the curated
    // documents get the newest times, set explicitly so the order never rests on clock ticks.
    const now = Date.now();
    for (const [index, item] of memory.entries()) {
      const updatedAt = new Date(now - (memory.length - 1 - index));
      const toBot = destinations.get(item.id) === "bot";
      const path = !toBot
        ? item.spacePath
        : target
          ? freeAgentImportMemoryPath(item.path, botPaths)
          : item.path;
      const seeded =
        !target && toBot && path === MEMORY_INDEX_PATH
          ? await tx.memoryDocument.findFirst({
              where: { ...owner, scope: "bot", botId, path },
              select: { id: true },
            })
          : null;
      const document = seeded
        ? await tx.memoryDocument.update({
            where: { id: seeded.id },
            data: { content: item.content, updatedAt },
          })
        : await tx.memoryDocument.create({
            data: {
              ...owner,
              scope: toBot ? "bot" : "user",
              botId: toBot ? botId : null,
              path,
              content: item.content,
              updatedAt,
            },
          });
      await tx.memoryRevision.create({
        data: { documentId: document.id, revision: document.revision, content: item.content },
      });
      if (!toBot) record.spaceMemory.push({ id: document.id, revision: document.revision });
      else if (target) record.botMemory.push({ id: document.id, revision: document.revision });
    }
    for (const item of resolved.skills.filter((skill) => skillIds.includes(skill.id))) {
      const row = await tx.agentSkill
        .create({
          data: {
            ...owner,
            name: item.name,
            description: item.description,
            content: item.content,
            source: "user",
          },
        })
        .catch(conflict("A skill with that name was just added. Try again."));
      record.skills.push({ id: row.id, hash: contentHash(row.content) });
      if (item.status.kind === "needs_setup") {
        setup.push({ kind: "skill", name: row.name, needs: item.status.needs });
      }
    }
    // Imported servers are not given to the bot: an approval card in its chat lets the
    // user grant them, as when a bot asks for a server itself.
    const thread = await tx.thread.findFirstOrThrow({
      where: { ...owner, botId },
      select: { id: true },
    });
    // Slugs are checked again in the transaction, like skill names above.
    const slugs = new Set(
      (await tx.mcpServer.findMany({ where: owner, select: { slug: true } })).map(
        (row) => row.slug,
      ),
    );
    for (const prepared of preparedServers) {
      const slug = freeSlug(prepared.config.slug, slugs);
      const config = {
        ...prepared.config,
        slug,
        ...(slug !== prepared.config.slug ? { name: slug } : {}),
      };
      const row = await services
        .insertMcpServer(tx, actor, config, prepared.stored)
        .catch(conflict("An MCP server with that name was just added. Try again."));
      await createThreadMessageInTransaction(tx, {
        threadId: thread.id,
        role: "bot",
        blocks: [
          {
            kind: "mcp_approval",
            name: row.name,
            serverId: row.id,
            transport: config.transport,
            endpoint: row.endpoint,
            needsOAuth: false,
            status: "pending",
          },
        ],
      });
      const status = plan.mcpServers.find((item) => item.id === prepared.id)?.status;
      const named = (kind: "credentials" | "env") =>
        status?.kind === "needs_setup"
          ? status.needs.flatMap((need) => (need.kind === kind ? need.names : []))
          : [];
      record.mcpServers.push({
        id: row.id,
        revision: row.revision,
        credentials: named("credentials"),
        env: named("env"),
        unverifiable:
          status?.kind === "needs_setup" &&
          status.needs.some((need) => need.kind === "program" || need.kind === "local_paths"),
      });
      if (status?.kind === "needs_setup") {
        setup.push({ kind: "mcp", serverId: row.id, name: row.slug, needs: status.needs });
      }
    }
    for (const routine of routines) {
      const routineInput = { ...routine, botId };
      const row = await tx.routine.create({
        data: services.routineRowData(actor, routineInput, services.routineNextRunAt(routineInput)),
      });
      record.routines.push({ id: row.id, updatedAt: row.updatedAt.toISOString() });
      routineRows.push(row);
      setup.push({ kind: "routine", routineId: row.id, name: row.name });
    }
    // A model this import could not apply (its provider has no key here) is set up later.
    if (plan.model?.status === "needs_key" && !model) {
      setup.push({
        kind: "model",
        title: plan.model.title,
        provider: plan.model.provider,
        providerName: plan.model.providerName,
      });
    }
    // One checklist of what is left to set up, in the same transaction; none if nothing is.
    if (setup.length) {
      const message = await createThreadMessageInTransaction(tx, {
        threadId: thread.id,
        role: "bot",
        blocks: [{ kind: "import_setup", items: setup }],
      });
      record.setupMessageId = message.id;
    }
    // A new bot's memory is all from the import (and its starting index).
    if (!target) {
      record.botMemory = await tx.memoryDocument.findMany({
        where: { ...owner, scope: "bot", botId },
        select: { id: true, revision: true },
      });
    }
    await tx.agentImport.create({
      data: {
        ...owner,
        botId,
        source: plan.source,
        importKey: importKey ?? null,
        requestDigest: digest,
        created: record as unknown as Prisma.InputJsonValue,
      },
    });
    importedInto = botId;
  };
  let bot: Bot;
  try {
    if (target) {
      await services.inTransaction(async (tx) => {
        importedInto = null;
        // Writers take the thread before the bot row (see `commitBotUpdate`).
        if (target.threadId) {
          await tx.$queryRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR UPDATE`;
        }
        await write(tx, target.id);
      });
      bot = (await services.findBot(actor, target.id)) ?? target;
    } else {
      bot = await services.createBot(actor, {
        name: input.name!,
        title: "",
        description: input.description,
        instructions,
        notifyOnFinish: true,
        computerMode: input.computerMode,
        modelProvider: model?.provider ?? null,
        modelId: model?.modelId ?? null,
        spawnKey: input.spawnKey,
        seed: async (tx, botId) => {
          importedInto = null;
          await write(tx, botId);
        },
      });
    }
    // A spawn key already taken returns that bot without the import, and a rolled-back
    // attempt wrote into a bot that never committed: neither is this bot. What happens to the
    // record after the commit (an Undo, say) does not change that this import committed.
    if (importedInto !== bot.id) {
      throw refused("CONFLICT", "first_bot_exists", "Your first bot already exists.");
    }
  } catch (error) {
    if (error instanceof InstructionConflictError) {
      throw refused("CONFLICT", "instructions_changed", error.message);
    }
    // Two requests with one import key: the second's transaction lost the race.
    const winner = isUniqueViolation(error) ? await already() : null;
    if (!winner) throw error;
    return winner;
  }
  const settle = (label: string) => (error: unknown) => {
    getLogger().error(label, error);
  };
  // After the commit nothing may fail the import: each step is logged and left to the
  // existing recovery (catalog refresh on next read, the routine list's own scheduling).
  // Imported MCP servers are not probed or launched before the user approves them.
  for (const credential of record.credentials) {
    try {
      services.afterModelKey(credential.provider);
    } catch (error) {
      settle("imported key catalog refresh")(error);
    }
  }
  const thread = bot.threadId ? { id: bot.threadId } : null;
  for (const row of routineRows) {
    await services
      .announceRoutine(actor, { id: bot.id, thread }, row)
      .catch(settle("imported routine notice"));
  }
  return bot;
}

/** Undo's view of a bot's latest import: what it removes, and what it keeps because it changed. */
async function undoPlan(db: Prisma.TransactionClient | PrismaClient, actor: Actor, botId: string) {
  const owner = { spaceId: actor.spaceId, userId: actor.userId };
  // A bot can hold several imports (one that made it, others added to it); Undo is the latest.
  const found = await db.agentImport.findFirst({
    where: { ...owner, botId },
    orderBy: { createdAt: "desc" },
  });
  if (!found) return null;
  const record = found.created as unknown as ImportRecord;
  const existingBot = record.existingBot === true;
  const ids = <T extends { id: string }>(items: T[]) => items.map((item) => item.id);
  const [skills, documents, servers, credentials, botMemory, routines, bot] = await Promise.all([
    db.agentSkill.findMany({ where: { ...owner, id: { in: ids(record.skills) } } }),
    db.memoryDocument.findMany({
      where: { ...owner, scope: "user", id: { in: ids(record.spaceMemory) } },
    }),
    db.mcpServer.findMany({ where: { ...owner, id: { in: ids(record.mcpServers) } } }),
    db.userModelCredential.findMany({
      where: { userId: actor.userId, id: { in: ids(record.credentials) } },
      select: { label: true },
    }),
    // A new bot's memory goes with it; an existing bot keeps all but what the import added.
    db.memoryDocument.findMany({
      where: existingBot
        ? { ...owner, scope: "bot", botId, id: { in: ids(record.botMemory) } }
        : { ...owner, scope: "bot", botId },
    }),
    existingBot
      ? db.routine.findMany({ where: { botId, id: { in: ids(record.routines) } } })
      : Promise.resolve([]),
    db.bot.findFirst({
      where: { ...owner, id: botId },
      select: { instructions: true, modelProvider: true, modelId: true },
    }),
  ]);
  const hashes = new Map(record.skills.map((item) => [item.id, item.hash]));
  const revisions = new Map(
    [...record.spaceMemory, ...record.mcpServers, ...record.botMemory].map((item) => [
      item.id,
      item.revision,
    ]),
  );
  const routineTimes = new Map(record.routines.map((item) => [item.id, item.updatedAt]));
  const split = <T>(rows: T[], changed: (row: T) => boolean) => ({
    remove: rows.filter((row) => !changed(row)),
    keep: rows.filter(changed),
  });
  // A server stays when another bot now relies on it.
  const assignedElsewhere = await db.botMcpServer.findMany({
    where: { ...owner, serverId: { in: ids(record.mcpServers) }, botId: { not: botId } },
    select: { serverId: true },
  });
  const sharedServers = new Set(assignedElsewhere.map((row) => row.serverId));
  const plan = {
    existingBot,
    record,
    found,
    skills: split(skills, (row) => contentHash(row.content) !== hashes.get(row.id)),
    spaceMemory: split(documents, (row) => row.revision !== revisions.get(row.id)),
    mcpServers: split(
      servers,
      (row) => row.revision !== revisions.get(row.id) || sharedServers.has(row.id),
    ),
    // In an existing bot, each added document goes unless it changed since.
    addedBotMemory: existingBot
      ? split(botMemory, (row) => row.revision !== revisions.get(row.id))
      : { remove: [], keep: [] },
    routines: split(routines, (row) => row.updatedAt.toISOString() !== routineTimes.get(row.id)),
    // A new bot's memory written or edited after the import is archived to space memory, as
    // deleting a bot with "keep memories" does, instead of being deleted.
    botMemoryChanged:
      !existingBot && botMemory.some((row) => row.revision !== revisions.get(row.id)),
    botMemory: existingBot ? [] : botMemory,
    // A model set by the import goes back only while it is still the imported one.
    model: record.model
      ? bot?.modelProvider === record.model.imported.provider &&
        bot?.modelId === record.model.imported.modelId
        ? ("restore" as const)
        : ("keep" as const)
      : null,
    // Replaced instructions go back only while they are still the imported ones.
    instructions: record.instructions
      ? bot?.instructions === record.instructions.imported
        ? ("restore" as const)
        : ("keep" as const)
      : null,
  };
  const info = (
    removed: {
      skills: string[];
      spaceMemory: string[];
      mcpServers: string[];
      botMemory: string[];
      routines: string[];
    },
    instructions = plan.instructions,
    model = plan.model,
  ) => {
    const left = <T extends { id: string }>(rows: T[], gone: string[], label: (row: T) => string) =>
      rows.filter((row) => !gone.includes(row.id)).map(label);
    const gone = <T extends { id: string }>(rows: T[], ids: string[], label: (row: T) => string) =>
      rows.filter((row) => ids.includes(row.id)).map(label);
    const added = [...plan.addedBotMemory.remove, ...plan.addedBotMemory.keep];
    const result: AgentImportInfo = {
      source: found.source as AgentImportSource,
      createdAt: found.createdAt.toISOString(),
      existingBot,
      instructions,
      model,
      remove: {
        skills: gone(skills, removed.skills, (row) => row.name),
        spaceMemory: gone(documents, removed.spaceMemory, (row) => row.path),
        // Slugs, not display names: two imports can each bring a server named the same.
        mcpServers: gone(servers, removed.mcpServers, (row) => row.slug),
        apiKeys: [],
        botMemory: gone(added, removed.botMemory, (row) => row.path),
        routines: gone(routines, removed.routines, (row) => row.name),
      },
      keep: {
        skills: left(skills, removed.skills, (row) => row.name),
        spaceMemory: [
          ...left(documents, removed.spaceMemory, (row) => row.path),
          ...(plan.botMemoryChanged ? botMemory.map((row) => row.path) : []),
        ],
        mcpServers: left(servers, removed.mcpServers, (row) => row.slug),
        // Keys are account connections other bots and spaces use; Undo never removes them.
        apiKeys: credentials.map((row) => row.label).sort(),
        botMemory: left(added, removed.botMemory, (row) => row.path),
        routines: left(routines, removed.routines, (row) => row.name),
      },
    };
    return result;
  };
  const planned = {
    skills: ids(plan.skills.remove),
    spaceMemory: ids(plan.spaceMemory.remove),
    mcpServers: ids(plan.mcpServers.remove),
    botMemory: ids(plan.addedBotMemory.remove),
    routines: ids(plan.routines.remove),
  };
  return { record, plan, info: info(planned), infoFor: info };
}

/**
 * Whether each item on an import's setup checklist is done now: a model connected for the
 * provider; an MCP server given to this bot AND holding a non-blank value for every header
 * and setting it was shown to need (or `unverifiable` when it needs a program or local
 * paths); a routine turned on. Only the actor's own rows are read; unknown ids are not done.
 */
export async function agentImportSetupState(
  services: AgentImportServices,
  actor: Actor,
  input: { botId: string; providers: string[]; serverIds: string[]; routineIds: string[] },
): Promise<AgentImportSetupState> {
  const owner = { spaceId: actor.spaceId, userId: actor.userId };
  const db = services.prisma;
  const [servers, assigned, routines, imports] = await Promise.all([
    db.mcpServer.findMany({
      where: { ...owner, id: { in: input.serverIds } },
      select: { id: true, secretId: true },
    }),
    db.botMcpServer.findMany({
      where: { ...owner, botId: input.botId, serverId: { in: input.serverIds } },
      select: { serverId: true },
    }),
    db.routine.findMany({
      where: { botId: input.botId, id: { in: input.routineIds }, bot: owner },
      select: { id: true, active: true },
    }),
    // What each imported server was shown to need, from this bot's own import records.
    db.agentImport.findMany({ where: { ...owner, botId: input.botId }, select: { created: true } }),
  ]);
  const needed = new Map(
    imports.flatMap((row) =>
      (row.created as unknown as ImportRecord).mcpServers.map(
        (server) => [server.id, server] as const,
      ),
    ),
  );
  const given = new Set(assigned.map((row) => row.serverId));
  const set = (value: string | undefined) => typeof value === "string" && value.trim() !== "";
  // A server is set up when it is given to this bot and every header and setting it was shown
  // to need has a non-blank stored value. Approval alone is not setup; a program or local
  // paths cannot be checked from here; a record without its requirements is unknown.
  const serverState = async (id: string): Promise<AgentImportSetupState["serverIds"][string]> => {
    const row = servers.find((server) => server.id === id);
    const need = needed.get(id);
    if (!row || !need || !Array.isArray(need.credentials) || !Array.isArray(need.env)) {
      return false;
    }
    if (need.unverifiable) return "unverifiable";
    if (!given.has(id)) return false;
    if (need.credentials.length === 0 && need.env.length === 0) return true;
    // Unreadable material (null) leaves the server not done; nothing about it is returned.
    const values = row.secretId
      ? await services.mcpCredentialValues(actor, { id: row.id, secretId: row.secretId })
      : null;
    if (!values) return false;
    return (
      need.credentials.every((name) => set(values.headers[name])) &&
      need.env.every((name) => set(values.env[name]))
    );
  };
  // Each server once: a repeated id is decrypted a single time.
  const serverIds = [...new Set(input.serverIds)];
  const serverStates = Object.fromEntries(
    await Promise.all(serverIds.map(async (id) => [id, await serverState(id)] as const)),
  );
  // Each provider once, with one read of the actor's connections.
  const providers = [...new Set(input.providers)];
  const connected = await services.connectedProviders(actor, providers);
  return {
    providers: Object.fromEntries(providers.map((provider) => [provider, connected.has(provider)])),
    serverIds: serverStates,
    routineIds: Object.fromEntries(
      input.routineIds.map((id) => [id, routines.some((row) => row.id === id && row.active)]),
    ),
  };
}

export async function agentImportInfo(
  services: AgentImportServices,
  actor: Actor,
  botId: string,
): Promise<AgentImportInfo | null> {
  return (await undoPlan(services.prisma, actor, botId))?.info ?? null;
}

/**
 * Undoes a bot's latest import. For a bot the import created, removes the bot and what the
 * import added, in the bot deletion's transaction. For an existing bot, removes only what
 * the import added and keeps the bot. Anything changed since is kept and reported; API keys
 * always stay.
 */
export async function undoAgentImport(
  services: AgentImportServices,
  actor: Actor,
  botId: string,
): Promise<AgentImportInfo> {
  const before = await undoPlan(services.prisma, actor, botId);
  if (!before) throw refused("NOT_FOUND", "not_imported", "This bot was not imported.");
  const owner = { spaceId: actor.spaceId, userId: actor.userId };
  let result = before.info;
  // Chat events Undo appends (closed MCP cards, the retired checklist), sent once committed.
  let changed: { threadId: string; seq: number }[] = [];
  const announce = async () => {
    for (const event of changed) {
      await services.notifyThread(event.threadId, event.seq).catch(() => undefined);
    }
  };
  // Locks what Undo may remove, then decides again: an edit or assignment made meanwhile
  // either landed (and is seen) or waits for this transaction.
  const removeAdded = async (tx: Prisma.TransactionClient) => {
    const { record } = before;
    const ids = <T extends { id: string }>(items: T[]) => items.map((item) => item.id);
    const skillIds = ids(record.skills);
    const documentIds = [...ids(record.spaceMemory), ...ids(record.botMemory)];
    const serverIds = ids(record.mcpServers);
    const routineIds = ids(record.routines);
    await tx.$queryRaw`SELECT id FROM agent_skills WHERE id = ANY(${skillIds}) FOR UPDATE`;
    await tx.$queryRaw`
      SELECT id FROM memory_documents
      WHERE id = ANY(${documentIds}) OR "botId" = ${botId}
      FOR UPDATE
    `;
    await tx.$queryRaw`SELECT id FROM mcp_servers WHERE id = ANY(${serverIds}) FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM routines WHERE id = ANY(${routineIds}) FOR UPDATE`;
    const current = await undoPlan(tx, actor, botId);
    if (!current || current.plan.found.id !== before.plan.found.id) {
      throw refused("CONFLICT", "import_changed", "This import changed. Try again.");
    }
    const { plan } = current;
    // Each delete also matches the state it was decided on; the counts say what happened.
    const removed = {
      skills: [] as string[],
      spaceMemory: [] as string[],
      mcpServers: [] as string[],
      botMemory: [] as string[],
      routines: [] as string[],
    };
    for (const row of plan.skills.remove) {
      const { count } = await tx.agentSkill.deleteMany({
        where: { ...owner, id: row.id, updatedAt: row.updatedAt },
      });
      if (count) removed.skills.push(row.id);
    }
    for (const row of plan.spaceMemory.remove) {
      const { count } = await tx.memoryDocument.deleteMany({
        where: { ...owner, id: row.id, revision: row.revision },
      });
      if (count) removed.spaceMemory.push(row.id);
    }
    for (const row of plan.addedBotMemory.remove) {
      const { count } = await tx.memoryDocument.deleteMany({
        where: { ...owner, botId, id: row.id, revision: row.revision },
      });
      if (count) removed.botMemory.push(row.id);
    }
    for (const row of plan.routines.remove) {
      const { count } = await tx.routine.deleteMany({
        where: { botId, id: row.id, updatedAt: row.updatedAt },
      });
      if (count) removed.routines.push(row.id);
    }
    const events: { threadId: string; seq: number }[] = [];
    for (const server of plan.mcpServers.remove) {
      // The same writes as removing it in settings: its approval cards are dismissed.
      events.push(...(await services.removeMcpServer(tx, actor, server)));
      removed.mcpServers.push(server.id);
    }
    return { plan, current, removed, events };
  };

  if (before.plan.existingBot) {
    await services.inTransaction(async (tx) => {
      const thread = await tx.thread.findFirst({
        where: { ...owner, botId },
        select: { id: true },
      });
      if (thread) await tx.$queryRaw`SELECT id FROM threads WHERE id = ${thread.id} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM bots WHERE id = ${botId} FOR UPDATE`;
      const { plan, current, removed, events } = await removeAdded(tx);
      let instructions = plan.instructions;
      if (instructions === "restore" && plan.record.instructions) {
        // Through the recorded-edit path, so this restore can itself be undone.
        try {
          await writeBotInstructions(tx, {
            botId,
            versionId: plan.record.instructions.versionId,
            expectedInstructions: plan.record.instructions.imported,
            reason: "Restore",
          });
        } catch (error) {
          if (!(error instanceof InstructionConflictError)) throw error;
          instructions = "keep";
        }
      }
      const model = plan.model;
      if (model === "restore" && plan.record.model) {
        const { previous } = plan.record.model;
        await tx.bot.update({
          where: { id: botId },
          data: { modelProvider: previous.provider, modelId: previous.modelId },
        });
      }
      // The bot stays, so does its chat: its checklist would link to what Undo removed.
      if (thread && plan.record.setupMessageId) {
        const retired = await retireSetupMessage(
          tx,
          actor,
          { botId, threadId: thread.id },
          plan.record.setupMessageId,
        );
        if (retired) events.push(retired);
      }
      await tx.agentImport.delete({ where: { id: plan.found.id } });
      result = current.infoFor(removed, instructions);
      changed = events;
    });
    await announce();
    return result;
  }

  await services.destroyBot(actor, botId, {
    deleteMemories: false,
    // Runs after the bot row is locked: the rest is decided again under the locks.
    within: async (tx) => {
      const { plan, current, removed, events } = await removeAdded(tx);
      result = current.infoFor(removed);
      changed = events;
      return { deleteMemories: !plan.botMemoryChanged };
    },
  });
  // Cards in other chats (a group) the removed servers closed.
  await announce();
  return result;
}

/**
 * Marks an import's checklist undone, the way other cards are settled: the message is
 * updated in place and the change is sent to open chats.
 */
async function retireSetupMessage(
  tx: Prisma.TransactionClient,
  actor: Actor,
  target: { botId: string; threadId: string },
  messageId: string,
) {
  const message = await tx.message.findFirst({
    where: { id: messageId, threadId: target.threadId },
    select: { blocks: true },
  });
  const parsed = MessageBlockSchema.array().safeParse(message?.blocks);
  if (!parsed.success) return null;
  // Emptied as well as marked: clients that predate `undone` already hide an empty one.
  const blocks = parsed.data.map((block) =>
    block.kind === "import_setup" ? { ...block, items: [], undone: true } : block,
  );
  await tx.message.update({
    where: { id: messageId },
    data: { blocks: blocks as Prisma.InputJsonValue },
  });
  const event = await appendEventInTransaction(tx, {
    spaceId: actor.spaceId,
    threadId: target.threadId,
    botId: target.botId,
    type: "thread.message.updated",
    payload: { messageId, role: "bot", blocks },
  });
  return { threadId: target.threadId, seq: event.seq };
}

/** SHA-256 of a create request with object keys and lists in a fixed order. */
export function requestDigest(request: unknown): string {
  // Every list in a create request is a set (files have unique paths; selections are ids;
  // skill files are names), so lists are sorted too: the same import in another order
  // is the same request.
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value
          .map((item) => JSON.stringify(canonical(item)))
          .sort()
          .map((item) => JSON.parse(item) as unknown)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
          )
        : value;
  return createHash("sha256")
    .update(JSON.stringify(canonical(request)))
    .digest("hex");
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * A key the import could not connect, as a reason the client words itself. The provider's
 * own text is never passed on: it can echo details of the request.
 */
function keyCheckFailure(error: unknown, provider: string) {
  if (signalAborted(error)) return error;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  const reason: AgentImportErrorReason = message.includes("rejected")
    ? "key_rejected"
    : message.includes("could not verify")
      ? "key_unverified"
      : "key_check_failed";
  return new ORPCError("BAD_REQUEST", {
    message: `The ${provider} API key could not be connected.`,
    data: { reason, provider },
  });
}

function signalAborted(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/** An error a client shows in its own words, by `data.reason`. */
function refused(
  code: "BAD_REQUEST" | "CONFLICT" | "NOT_FOUND" | "PRECONDITION_FAILED",
  reason: AgentImportErrorReason,
  message: string,
) {
  return new ORPCError(code, { message, data: { reason } });
}

function conflict(message: string) {
  return (error: unknown): never => {
    if (isUniqueViolation(error)) throw refused("CONFLICT", "name_just_taken", message);
    throw error;
  };
}

function freeSlug(slug: string, used: Set<string>): string {
  let candidate = slug;
  for (let n = 2; used.has(candidate); n += 1) {
    const tail = `-${n}`;
    candidate = `${slug.slice(0, 64 - tail.length)}${tail}`;
  }
  used.add(candidate);
  return candidate;
}

/** Daily logs and other notes first (in plan order, oldest first), then USER.md, then MEMORY.md. */
function curatedRank(path: string): number {
  return path === MEMORY_INDEX_PATH ? 2 : path === "USER.md" ? 1 : 0;
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}
