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
  MessageBlock,
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
  extractRoutineSkillMentions,
  freeAgentImportMemoryPath,
  parseAgentImport,
  readAgentImportFolder,
  renameRoutineSkillMentions,
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
 * The router's own write paths, so imported settings are validated, encrypted and scheduled
 * exactly as when added by hand.
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
  /** Decrypted only to tell set from blank; never returned to a client. */
  mcpCredentialValues: (
    actor: Actor,
    server: { id: string; secretId: string },
  ) => Promise<{ headers: Record<string, string>; env: Record<string, string> } | null>;
  connectedProviders: (actor: Actor, providers: string[]) => Promise<Set<string>>;
  /** `bots.update`'s model check; an error message or null. */
  validateBotModel: (actor: Actor, provider: string, modelId: string) => Promise<string | null>;
  stdioAllowed: (command: string) => boolean;
  /** `models.connect`'s checks and encryption for a key, without writing it. */
  prepareModelKey: (
    actor: Actor,
    input: { provider: string; apiKey: string; modelId?: string },
    signal?: AbortSignal,
  ) => Promise<PreparedKey>;
  /** Create-only: null, and nothing written, when the provider is already connected. */
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
  /** Serializable and retried on conflict, like `createBot`'s transaction. */
  inTransaction: <T>(run: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;
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
  destroyBot: (
    actor: Actor,
    botId: string,
    options: {
      deleteMemories: boolean;
      within: (tx: Prisma.TransactionClient) => Promise<{ deleteMemories: boolean } | undefined>;
    },
  ) => Promise<void>;
  /** Returns the chat events its closed approval cards appended. */
  removeMcpServer: (
    tx: Prisma.TransactionClient,
    actor: Actor,
    server: { id: string; secretId: string | null },
  ) => Promise<{ threadId: string; seq: number }[]>;
  notifyThread: (threadId: string, seq: number) => Promise<void>;
};

/** What an import created and how it looked then, so Undo removes only what is unchanged. */
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
  existingBot?: boolean;
  setupMessageId?: string;
  /** `versionId` is the history entry holding the replaced instructions. */
  instructions?: { versionId: string; imported: string };
  model?: {
    previous: { provider: string | null; modelId: string | null };
    imported: { provider: string; modelId: string };
  };
};

const BLOCKING: ReadonlySet<AgentImportWarning> = new Set(["unsupported_command"]);

function parsePlan(files: AgentImportFile[], skillFiles: SkillFiles): AgentImportPlan {
  const plan = parseAgentImport(files, skillFiles);
  if ("error" in plan) throw new ORPCError("BAD_REQUEST", { message: plan.error });
  return plan;
}

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
  connectedKeyIds: Set<string>;
};

/** Key values stay in `settings.keyValues` and never enter the plan. */
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
  const connectedKeyIds = new Set<string>();
  if (!folder) return { plan, settings: null, routineInputs, mcpConfigs, connectedKeyIds };
  const settings = readAgentImportSettings(folder, {
    includeSecrets,
    stdioAllowed: services.stdioAllowed,
  });

  let model: AgentImportPlan["model"] = null;
  if (settings.model) {
    const { title, provider, providerName, modelId, known } = settings.model;
    const usable = (await services.validateBotModel(actor, provider, modelId)) === null;
    const status = usable ? "ready" : known ? "needs_key" : "unknown";
    model = { id: "model", title, provider, providerName, modelId, status };
  }

  const skipped = [...plan.skipped, ...settings.skipped];
  const apiKeys: AgentImportPlan["apiKeys"] = [];
  for (const key of settings.apiKeys) {
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

/** In plan order; unknown or repeated ids are refused. */
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
  if (picked.some((item) => item.status?.kind === "unsupported")) {
    throw refused("BAD_REQUEST", "cannot_run_here", "That item cannot work here.");
  }
  return picked;
}

/**
 * Re-reads the files (nothing is staged between preview and create), runs every check and
 * encryption, then writes everything and the import record in one transaction.
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
  const retried = await already();
  if (retried) return retried;
  const destination = input.destination;
  if (destination.kind === "existing" && input.spawnKey) {
    throw refused("BAD_REQUEST", "first_bot_new_only", "A first bot is always a new bot.");
  }
  if (destination.kind === "new" && !input.name) {
    throw refused("BAD_REQUEST", "name_required", "Name the new bot.");
  }
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
  // A key whose provider was connected after the preview is still selected; skip it.
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

  // A key for the chosen model's provider is checked against that model too.
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
  // Attempts can roll back (serialization retry) or be skipped (first bot made meanwhile),
  // so the import committed exactly when the returned bot is the one last written into.
  let importedInto: string | null = null;
  let added: { threadId: string; seq: number }[] = [];
  const announceAdded = async (
    tx: Prisma.TransactionClient,
    botId: string,
    message: { id: string },
    threadId: string,
    blocks: MessageBlock[],
  ) => {
    const event = await appendEventInTransaction(tx, {
      spaceId: actor.spaceId,
      threadId,
      botId,
      type: "thread.message.created",
      payload: { messageId: message.id, role: "bot", blocks },
    });
    added.push({ threadId, seq: event.seq });
  };
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
      const credential = await services.writeModelKey(tx, actor, prepared);
      if (credential) record.credentials.push(credential);
    }
    // The preview may be stale: names are resolved again under the creation lock.
    const taken = await takenNames(tx, actor);
    const resolved = resolveAgentImportNames(plan, taken);
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
    // Agent context reads newest memory first within a budget: curated documents get the
    // newest times, set explicitly rather than left to clock ticks.
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
    // Imported servers are not given to the bot; an approval card lets the user grant them.
    const thread = await tx.thread.findFirstOrThrow({
      where: { ...owner, botId },
      select: { id: true },
    });
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
      const card: MessageBlock[] = [
        {
          kind: "mcp_approval",
          name: row.name,
          serverId: row.id,
          transport: config.transport,
          endpoint: row.endpoint,
          needsOAuth: false,
          status: "pending",
        },
      ];
      const cardMessage = await createThreadMessageInTransaction(tx, {
        threadId: thread.id,
        role: "bot",
        blocks: card,
      });
      await announceAdded(tx, botId, cardMessage, thread.id, card);
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
    // A skill renamed on a clash keeps its routines: `@garden` follows it to `garden-2`.
    // Every known name is matched, so `@garden tools` is never read as `@garden`.
    const originalNames = new Map(plan.skills.map((item) => [item.id, item.title]));
    const renamed = new Map<string, string>([
      ...taken.skillNames.map((name): [string, string] => [name, name]),
      ...resolved.skills.flatMap((item): [string, string][] => {
        const from = originalNames.get(item.id);
        return from ? [[from, skillIds.includes(item.id) ? item.name : from]] : [];
      }),
    ]);
    for (const routine of routines) {
      const routineInput = {
        ...routine,
        botId,
        prompt: renameRoutineSkillMentions(routine.prompt, renamed),
      };
      const row = await tx.routine.create({
        data: services.routineRowData(actor, routineInput, services.routineNextRunAt(routineInput)),
      });
      record.routines.push({ id: row.id, updatedAt: row.updatedAt.toISOString() });
      routineRows.push(row);
      setup.push({ kind: "routine", routineId: row.id, name: row.name });
    }
    if (plan.model?.status === "needs_key" && !model) {
      setup.push({
        kind: "model",
        title: plan.model.title,
        provider: plan.model.provider,
        providerName: plan.model.providerName,
      });
    }
    if (setup.length) {
      const checklist: MessageBlock[] = [{ kind: "import_setup", items: setup }];
      const message = await createThreadMessageInTransaction(tx, {
        threadId: thread.id,
        role: "bot",
        blocks: checklist,
      });
      await announceAdded(tx, botId, message, thread.id, checklist);
      record.setupMessageId = message.id;
    }
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
        added = [];
        // Writers take the thread before the bot row (see `commitBotUpdate`).
        if (target.threadId) {
          await tx.$queryRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR UPDATE`;
        }
        // Undo archives a bot it is about to delete.
        const live = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM bots WHERE id = ${target.id} AND "archivedAt" IS NULL FOR UPDATE
        `;
        if (!live.length) throw new IsolationError();
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
          added = [];
          await write(tx, botId);
        },
      });
    }
    // A taken spawn key returns that bot without running the import.
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
  // Nothing may fail the import after its commit: failures are logged and left to the
  // existing recovery. MCP servers are not probed before the user approves them.
  for (const credential of record.credentials) {
    try {
      services.afterModelKey(credential.provider);
    } catch (error) {
      settle("imported key catalog refresh")(error);
    }
  }
  for (const event of added) {
    await services.notifyThread(event.threadId, event.seq).catch(settle("imported card notice"));
  }
  const thread = bot.threadId ? { id: bot.threadId } : null;
  for (const row of routineRows) {
    await services
      .announceRoutine(actor, { id: bot.id, thread }, row)
      .catch(settle("imported routine notice"));
  }
  return bot;
}

/** What Undo of a bot's latest import removes, and what it keeps because it changed. */
async function undoPlan(
  db: Prisma.TransactionClient | PrismaClient,
  actor: Actor,
  botId: string,
  importId?: string,
) {
  const owner = { spaceId: actor.spaceId, userId: actor.userId };
  // A bot can hold several imports; Undo takes the latest unless a reserved deletion names one.
  const found = await db.agentImport.findFirst({
    where: { ...owner, botId, ...(importId ? { id: importId } : {}) },
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
  const assignedElsewhere = await db.botMcpServer.findMany({
    where: { ...owner, serverId: { in: ids(record.mcpServers) }, botId: { not: botId } },
    select: { serverId: true },
  });
  const sharedServers = new Set(assignedElsewhere.map((row) => row.serverId));
  const routineSplit = split(
    routines,
    (row) => row.updatedAt.toISOString() !== routineTimes.get(row.id),
  );
  // Skills are shared: one a surviving routine mentions stays, or that routine loses its steps.
  const survivingRoutines = await db.routine.findMany({
    where: {
      ...owner,
      NOT: existingBot ? { id: { in: ids(routineSplit.remove) } } : { botId },
    },
    select: { prompt: true },
  });
  const skillNames = skills.map((row) => row.name);
  const usedSkills = new Set(
    survivingRoutines.flatMap((row) =>
      extractRoutineSkillMentions(row.prompt, skillNames).map((name) => name.toLowerCase()),
    ),
  );
  const plan = {
    existingBot,
    record,
    found,
    skills: split(
      skills,
      (row) =>
        contentHash(row.content) !== hashes.get(row.id) || usedSkills.has(row.name.toLowerCase()),
    ),
    spaceMemory: split(documents, (row) => row.revision !== revisions.get(row.id)),
    mcpServers: split(
      servers,
      (row) => row.revision !== revisions.get(row.id) || sharedServers.has(row.id),
    ),
    addedBotMemory: existingBot
      ? split(botMemory, (row) => row.revision !== revisions.get(row.id))
      : { remove: [], keep: [] },
    routines: routineSplit,
    // Edited memory of a new bot is archived to space memory, as "keep memories" would.
    botMemoryChanged:
      !existingBot && botMemory.some((row) => row.revision !== revisions.get(row.id)),
    botMemory: existingBot ? [] : botMemory,
    model: record.model
      ? bot?.modelProvider === record.model.imported.provider &&
        bot?.modelId === record.model.imported.modelId
        ? ("restore" as const)
        : ("keep" as const)
      : null,
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
      id: found.id,
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

/** Only the actor's own rows are read; unknown ids are not done. */
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
  const nonBlank = (value: string | undefined) => typeof value === "string" && value.trim() !== "";
  // Approval alone is not setup: every value the server was shown to need must be stored.
  const serverState = async (id: string): Promise<AgentImportSetupState["serverIds"][string]> => {
    const row = servers.find((server) => server.id === id);
    const need = needed.get(id);
    if (!row || !need || !Array.isArray(need.credentials) || !Array.isArray(need.env)) {
      return false;
    }
    if (need.unverifiable) return "unverifiable";
    if (!given.has(id)) return false;
    if (need.credentials.length === 0 && need.env.length === 0) return true;
    const values = row.secretId
      ? await services.mcpCredentialValues(actor, { id: row.id, secretId: row.secretId })
      : null;
    if (!values) return false;
    return (
      need.credentials.every((name) => nonBlank(values.headers[name])) &&
      need.env.every((name) => nonBlank(values.env[name]))
    );
  };
  const serverIds = [...new Set(input.serverIds)];
  const serverStates = Object.fromEntries(
    await Promise.all(serverIds.map(async (id) => [id, await serverState(id)] as const)),
  );
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
 * Undoes the bot's latest import, only while it is the one the user was shown. Deletes a bot
 * the import created; anything changed since is kept and reported; API keys always stay.
 */
export async function undoAgentImport(
  services: AgentImportServices,
  actor: Actor,
  input: { botId: string; importId: string },
): Promise<AgentImportInfo> {
  const { botId } = input;
  const before = await undoPlan(services.prisma, actor, botId);
  if (!before) throw refused("NOT_FOUND", "not_imported", "This bot was not imported.");
  // Another tab may have undone the import that was shown, leaving an older one latest:
  // the import that made the bot, whose Undo deletes it.
  if (before.plan.found.id !== input.importId) {
    throw refused("CONFLICT", "import_changed", "This import changed. Try again.");
  }
  const owner = { spaceId: actor.spaceId, userId: actor.userId };
  let result = before.info;
  let changed: { threadId: string; seq: number }[] = [];
  const announce = async () => {
    for (const event of changed) {
      await services.notifyThread(event.threadId, event.seq).catch((error: unknown) => {
        getLogger().error("undone import notice", error);
      });
    }
  };
  // Locks what Undo may remove, then decides again: an edit or assignment made meanwhile
  // either landed (and is seen) or waits for this transaction.
  const removeAdded = async (tx: Prisma.TransactionClient, reservedImportId?: string) => {
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
    const current = await undoPlan(tx, actor, botId, reservedImportId);
    if (!current || current.plan.found.id !== before.plan.found.id) {
      throw refused("CONFLICT", "import_changed", "This import changed. Try again.");
    }
    const { plan } = current;
    // Each delete matches the state it was decided on; the counts say what happened.
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
      // The bot's chat stays, and its checklist would link to what Undo removed.
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

  // `destroyBot` cancels runs, destroys the computer and removes saved sessions before its
  // transaction, and none of that rolls back. So the confirmed import is checked and reserved
  // first, and from then on the deletion goes ahead, like removing the bot: a restore and a
  // later import meanwhile do not stop it. What that import added to the bot goes with it;
  // what it added outside the bot (skills, space memory, servers, keys) stays.
  const reservedAt = await services.prisma.$transaction(async (tx) => {
    const thread = await tx.thread.findFirst({ where: { ...owner, botId }, select: { id: true } });
    if (thread) await tx.$queryRaw`SELECT id FROM threads WHERE id = ${thread.id} FOR UPDATE`;
    const [bot] = await tx.$queryRaw<{ archivedAt: Date | null }[]>`
      SELECT "archivedAt" FROM bots WHERE id = ${botId} FOR UPDATE
    `;
    const current = bot ? await undoPlan(tx, actor, botId) : null;
    if (!current || current.plan.found.id !== input.importId) {
      throw refused("CONFLICT", "import_changed", "This import changed. Try again.");
    }
    if (bot!.archivedAt) return null;
    const at = new Date();
    await tx.bot.update({ where: { id: botId }, data: { archivedAt: at } });
    return at;
  });
  let removedAdded = false;
  try {
    await services.destroyBot(actor, botId, {
      deleteMemories: false,
      // Runs after the bot row is locked: the rest is decided again under the locks.
      within: async (tx) => {
        removedAdded = true;
        const { plan, current, removed, events } = await removeAdded(tx, input.importId);
        result = current.infoFor(removed);
        changed = events;
        return { deleteMemories: !plan.botMemoryChanged };
      },
    });
  } catch (error) {
    // The bot was not deleted: give it back as it was.
    if (reservedAt) {
      await services.prisma.bot
        .updateMany({ where: { id: botId, archivedAt: reservedAt }, data: { archivedAt: null } })
        .catch((restoreError: unknown) => {
          getLogger().error("undo bot restore", restoreError);
        });
    }
    throw error;
  }
  // A removal of the bot that committed first deleted it without undoing the import.
  if (!removedAdded) throw refused("CONFLICT", "import_changed", "This import changed. Try again.");
  await announce();
  return result;
}

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

/** Every list in a create request is a set, so keys and lists are sorted before hashing. */
export function requestDigest(request: unknown): string {
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

/** The provider's own error text is never passed on: it can echo details of the request. */
function keyCheckFailure(error: unknown, providerName: string) {
  if (signalAborted(error)) return error;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  const reason: AgentImportErrorReason = message.includes("rejected")
    ? "key_rejected"
    : message.includes("could not verify")
      ? "key_unverified"
      : "key_check_failed";
  return new ORPCError("BAD_REQUEST", {
    message: `The ${providerName} API key could not be connected.`,
    data: { reason, provider: providerName },
  });
}

function signalAborted(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

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
