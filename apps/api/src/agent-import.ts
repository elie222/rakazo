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
  AgentImportFile,
  AgentImportInfo,
  AgentImportMemoryDestination,
  AgentImportPlan,
  AgentImportSetupItem,
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
} from "@rakazo/contracts";
import type { SkillFiles } from "@rakazo/core";
import {
  combineImportedInstructions,
  parseAgentImport,
  readAgentImportFolder,
  resolveAgentImportNames,
} from "@rakazo/core";
import type { McpServer as McpServerRow, Prisma, PrismaClient, Routine } from "@rakazo/db";
import { createThreadMessageInTransaction } from "@rakazo/db";
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
  /** The writes of `mcp.servers.remove`. */
  removeMcpServer: (
    tx: Prisma.TransactionClient,
    actor: Actor,
    server: { id: string; secretId: string | null },
  ) => Promise<unknown>;
};

/**
 * What an import created and how it looked then, kept on its record so Undo removes only
 * what the user has not changed since.
 */
type ImportRecord = {
  skills: { id: string; hash: string }[];
  spaceMemory: { id: string; revision: number }[];
  botMemory: { id: string; revision: number }[];
  mcpServers: { id: string; revision: number }[];
  routines: { id: string }[];
  credentials: { id: string; secretId: string; provider: string }[];
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
  if (!folder) return { plan, settings: null, routineInputs, mcpConfigs };
  const settings = readAgentImportSettings(folder, {
    includeSecrets,
    stdioAllowed: services.stdioAllowed,
  });

  let model: AgentImportPlan["model"] = null;
  if (settings.model) {
    const { title, provider, modelId, known } = settings.model;
    // Usable means what `bots.update` would accept for this actor now: a connection for
    // that provider (or the deployment's hosted credits) and a model it can call.
    const usable = (await services.validateBotModel(actor, provider, modelId)) === null;
    const status = usable ? "ready" : known ? "needs_key" : "unknown";
    model = { id: "model", title, provider, modelId, status };
  }

  const skipped = [...plan.skipped, ...settings.skipped];
  const apiKeys: AgentImportPlan["apiKeys"] = [];
  for (const key of settings.apiKeys) {
    // An existing connection is never replaced by an import.
    if (await services.hasModelConnection(actor, key.provider)) {
      skipped.push({ path: key.source, reason: "connected" });
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
    throw new ORPCError("BAD_REQUEST", { message: "The selection does not match the files." });
  }
  const picked = items.filter((item) => chosen.has(item.id));
  if (picked.some((item) => item.warnings?.some((warning) => BLOCKING.has(warning)))) {
    throw new ORPCError("BAD_REQUEST", { message: "That MCP server cannot run here." });
  }
  // Not supported here at all (a skill for another platform): never created.
  if (picked.some((item) => item.status?.kind === "unsupported")) {
    throw new ORPCError("BAD_REQUEST", { message: "That item cannot work here." });
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
      throw new ORPCError("PRECONDITION_FAILED", {
        message: "This import was already used with different files or choices.",
      });
    }
    return services.findBot(actor, found.botId);
  };
  const existing = await already();
  if (existing) return existing;
  const { plan, settings, routineInputs, mcpConfigs } = await buildPlan(
    services as AgentImportServices,
    actor,
    input,
  );
  const instructions = combineImportedInstructions(
    selected(plan.instructions, input.selection.instructions),
  );
  if (instructions.length > BOT_INSTRUCTIONS_MAX_LENGTH) {
    throw new ORPCError("BAD_REQUEST", {
      message: `Instructions can be at most ${BOT_INSTRUCTIONS_MAX_LENGTH} characters. Import fewer files.`,
    });
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
  const keys = selected(plan.apiKeys, input.selection.apiKeys);
  const model = input.selection.model ? plan.model : null;
  if (input.selection.model) {
    const keyed = keys.some((key) => key.provider === model?.provider);
    const usable =
      model?.status === "ready" ||
      (model?.status === "needs_key" &&
        keyed &&
        isCatalogModelChoice(model.provider, model.modelId));
    if (!model || !usable) {
      throw new ORPCError("BAD_REQUEST", { message: "Connect this model's provider first." });
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
      await services.prepareModelKey(
        actor,
        {
          provider: key.provider,
          apiKey,
          modelId: model?.provider === key.provider ? model.modelId : undefined,
        },
        signal,
      ),
    );
  }
  const preparedServers: { id: string; config: McpServerConfigInput; stored: Stored }[] = [];
  for (const server of servers) {
    const config = { ...server.config, slug: server.slug };
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
  let seeded = false;
  const created = services.createBot(actor, {
    name: input.name,
    title: "",
    description: input.description,
    instructions,
    notifyOnFinish: true,
    computerMode: input.computerMode,
    modelProvider: model?.provider ?? null,
    modelId: model?.modelId ?? null,
    spawnKey: input.spawnKey,
    seed: async (tx, botId) => {
      seeded = true;
      // A serialization conflict runs the seed again: start each attempt clean.
      for (const list of Object.values(record)) list.length = 0;
      routineRows.length = 0;
      setup.length = 0;
      for (const prepared of preparedKeys) {
        // Only keys this import created are recorded; one connected meanwhile stays as is.
        const credential = await services.writeModelKey(tx, actor, prepared);
        if (credential) record.credentials.push(credential);
      }
      // Names are checked again under the creation lock: the preview may be stale.
      const resolved = resolveAgentImportNames(plan, await takenNames(tx, actor));
      const memory = resolved.memory
        .filter((item) => memoryIds.includes(item.id))
        .sort((left, right) => curatedRank(left.path) - curatedRank(right.path));
      // Agent context reads the newest memory first within a size budget, so the curated
      // documents get the newest times, set explicitly so the order never rests on clock ticks.
      const now = Date.now();
      for (const [index, item] of memory.entries()) {
        const updatedAt = new Date(now - (memory.length - 1 - index));
        const toBot = destinations.get(item.id) === "bot";
        const path = toBot ? item.path : item.spacePath;
        const seeded =
          toBot && path === MEMORY_INDEX_PATH
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
        const config = { ...prepared.config, slug: freeSlug(prepared.config.slug, slugs) };
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
        record.mcpServers.push({ id: row.id, revision: row.revision });
        const status = plan.mcpServers.find((item) => item.id === prepared.id)?.status;
        if (status?.kind === "needs_setup") {
          setup.push({ kind: "mcp", serverId: row.id, name: row.slug, needs: status.needs });
        }
      }
      for (const routine of routines) {
        const routineInput = { ...routine, botId };
        const row = await tx.routine.create({
          data: services.routineRowData(
            actor,
            routineInput,
            services.routineNextRunAt(routineInput),
          ),
        });
        record.routines.push({ id: row.id });
        routineRows.push(row);
        setup.push({ kind: "routine", routineId: row.id, name: row.name });
      }
      // A model this import could not apply (its provider has no key here) is set up later.
      if (plan.model?.status === "needs_key" && !model) {
        setup.push({ kind: "model", title: plan.model.title, provider: plan.model.provider });
      }
      // One checklist of what is left to set up, in the same transaction; none if nothing is.
      if (setup.length) {
        await createThreadMessageInTransaction(tx, {
          threadId: thread.id,
          role: "bot",
          blocks: [{ kind: "import_setup", items: setup }],
        });
      }
      const botMemory = await tx.memoryDocument.findMany({
        where: { ...owner, scope: "bot", botId },
        select: { id: true, revision: true },
      });
      record.botMemory = botMemory;
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
    },
  });
  let bot: Bot;
  try {
    bot = await created;
  } catch (error) {
    // Two requests with one import key: the second's transaction lost the race.
    const winner = isUniqueViolation(error) ? await already() : null;
    if (!winner) throw error;
    return winner;
  }
  // A spawn key already taken returns that bot without running the import.
  if (!seeded) throw new ORPCError("CONFLICT", { message: "Your first bot already exists." });
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

/** Undo's view of an imported bot: what it removes, and what it keeps because it changed. */
async function undoPlan(db: Prisma.TransactionClient | PrismaClient, actor: Actor, botId: string) {
  const owner = { spaceId: actor.spaceId, userId: actor.userId };
  const found = await db.agentImport.findFirst({ where: { ...owner, botId } });
  if (!found) return null;
  const record = found.created as unknown as ImportRecord;
  const ids = <T extends { id: string }>(items: T[]) => items.map((item) => item.id);
  const [skills, documents, servers, credentials, botMemory] = await Promise.all([
    db.agentSkill.findMany({ where: { ...owner, id: { in: ids(record.skills) } } }),
    db.memoryDocument.findMany({
      where: { ...owner, scope: "user", id: { in: ids(record.spaceMemory) } },
    }),
    db.mcpServer.findMany({ where: { ...owner, id: { in: ids(record.mcpServers) } } }),
    db.userModelCredential.findMany({
      where: { userId: actor.userId, id: { in: ids(record.credentials) } },
      select: { label: true },
    }),
    db.memoryDocument.findMany({ where: { ...owner, scope: "bot", botId } }),
  ]);
  const hashes = new Map(record.skills.map((item) => [item.id, item.hash]));
  const revisions = new Map(
    [...record.spaceMemory, ...record.mcpServers, ...record.botMemory].map((item) => [
      item.id,
      item.revision,
    ]),
  );
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
    skills: split(skills, (row) => contentHash(row.content) !== hashes.get(row.id)),
    spaceMemory: split(documents, (row) => row.revision !== revisions.get(row.id)),
    mcpServers: split(
      servers,
      (row) => row.revision !== revisions.get(row.id) || sharedServers.has(row.id),
    ),
    // Memory the bot wrote or edited after the import is archived to space memory, as
    // deleting a bot with "keep memories" does, instead of being deleted.
    botMemoryChanged: botMemory.some((row) => row.revision !== revisions.get(row.id)),
    botMemory,
  };
  const info = (removed: { skills: string[]; spaceMemory: string[]; mcpServers: string[] }) => {
    const left = <T extends { id: string }>(rows: T[], gone: string[], label: (row: T) => string) =>
      rows.filter((row) => !gone.includes(row.id)).map(label);
    const gone = <T extends { id: string }>(rows: T[], ids: string[], label: (row: T) => string) =>
      rows.filter((row) => ids.includes(row.id)).map(label);
    const result: AgentImportInfo = {
      source: found.source as AgentImportSource,
      createdAt: found.createdAt.toISOString(),
      remove: {
        skills: gone(skills, removed.skills, (row) => row.name),
        spaceMemory: gone(documents, removed.spaceMemory, (row) => row.path),
        // Slugs, not display names: two imports can each bring a server named the same.
        mcpServers: gone(servers, removed.mcpServers, (row) => row.slug),
        apiKeys: [],
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
      },
    };
    return result;
  };
  const planned = {
    skills: ids(plan.skills.remove),
    spaceMemory: ids(plan.spaceMemory.remove),
    mcpServers: ids(plan.mcpServers.remove),
  };
  return { record, plan, info: info(planned), infoFor: info };
}

export async function agentImportInfo(
  services: AgentImportServices,
  actor: Actor,
  botId: string,
): Promise<AgentImportInfo | null> {
  return (await undoPlan(services.prisma, actor, botId))?.info ?? null;
}

/**
 * Removes an imported bot and what its import created, in the bot deletion's transaction.
 * Anything the user changed since the import is kept and reported; API keys always stay.
 */
export async function undoAgentImport(
  services: AgentImportServices,
  actor: Actor,
  botId: string,
): Promise<AgentImportInfo> {
  const before = await undoPlan(services.prisma, actor, botId);
  if (!before) throw new ORPCError("NOT_FOUND", { message: "This bot was not imported." });
  let result = before.info;
  const owner = { spaceId: actor.spaceId, userId: actor.userId };
  await services.destroyBot(actor, botId, {
    deleteMemories: false,
    // Runs after the bot row is locked. The candidate rows are locked too, then everything
    // is decided again: an edit or assignment made meanwhile either landed (and is seen
    // here) or waits for this transaction.
    within: async (tx) => {
      const { record } = before;
      const ids = <T extends { id: string }>(items: T[]) => items.map((item) => item.id);
      const skillIds = ids(record.skills);
      const documentIds = [...ids(record.spaceMemory), ...ids(record.botMemory)];
      const serverIds = ids(record.mcpServers);
      await tx.$queryRaw`SELECT id FROM agent_skills WHERE id = ANY(${skillIds}) FOR UPDATE`;
      await tx.$queryRaw`
        SELECT id FROM memory_documents
        WHERE id = ANY(${documentIds}) OR "botId" = ${botId}
        FOR UPDATE
      `;
      await tx.$queryRaw`SELECT id FROM mcp_servers WHERE id = ANY(${serverIds}) FOR UPDATE`;
      const current = await undoPlan(tx, actor, botId);
      if (!current) throw new ORPCError("NOT_FOUND", { message: "This bot was not imported." });
      const { plan } = current;
      // Each delete also matches the state it was decided on; the counts say what happened.
      const removed = {
        skills: [] as string[],
        spaceMemory: [] as string[],
        mcpServers: [] as string[],
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
      for (const server of plan.mcpServers.remove) {
        await services.removeMcpServer(tx, actor, server);
        removed.mcpServers.push(server.id);
      }
      result = current.infoFor(removed);
      return { deleteMemories: !plan.botMemoryChanged };
    },
  });
  return result;
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

function conflict(message: string) {
  return (error: unknown): never => {
    if (isUniqueViolation(error)) throw new ORPCError("CONFLICT", { message });
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
