import { ORPCError } from "@orpc/server";
import type { SecretStore } from "@rakazo/adapter-kit";
import type { AgentImportSettings, ImportedMcpServer } from "@rakazo/adapters";
import { BUILTIN_AGENT_SKILLS, readAgentImportSettings } from "@rakazo/adapters";
import type {
  Actor,
  AgentImportCreateInput,
  AgentImportFile,
  AgentImportMemoryDestination,
  AgentImportPlan,
  Bot,
  CreateRoutineInput as CreateRoutineInputType,
  McpServerConfigInput,
  ModelConnectInput,
} from "@rakazo/contracts";
import {
  BOT_INSTRUCTIONS_MAX_LENGTH,
  CreateRoutineInput,
  isValidTimeZone,
  MEMORY_INDEX_PATH,
  ModelConnectInputSchema,
} from "@rakazo/contracts";
import {
  combineImportedInstructions,
  parseAgentImport,
  readAgentImportFolder,
  resolveAgentImportNames,
} from "@rakazo/core";
import type { McpServer as McpServerRow, Prisma, PrismaClient, Routine } from "@rakazo/db";

type Reader = Pick<Prisma.TransactionClient, "memoryDocument" | "agentSkill" | "mcpServer">;
type Stored = Awaited<ReturnType<SecretStore["put"]>> | null;

/**
 * The existing paths an import writes through, built by the router so each setting is
 * validated, encrypted and scheduled exactly as when the user adds it by hand.
 */
export type AgentImportServices = {
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
      seed: (tx: Prisma.TransactionClient, botId: string) => Promise<void>;
    },
  ) => Promise<Bot>;
  hasModelConnection: (actor: Actor, provider: string) => Promise<boolean>;
  /** `models.connect`, keeping the user's existing default model (imports add, not switch). */
  connectModel: (actor: Actor, input: ModelConnectInput, signal?: AbortSignal) => Promise<unknown>;
  /** `bots.update`'s model check; an error message or null. */
  validateBotModel: (actor: Actor, provider: string, modelId: string) => Promise<string | null>;
  prepareMcpServer: (actor: Actor, input: McpServerConfigInput) => Promise<Stored>;
  insertMcpServer: (
    tx: Prisma.TransactionClient,
    actor: Actor,
    input: McpServerConfigInput,
    stored: Stored,
  ) => Promise<McpServerRow>;
  announceMcpServer: (row: McpServerRow, actor: Actor) => Promise<unknown>;
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
};

function parsePlan(files: AgentImportFile[]): AgentImportPlan {
  const plan = parseAgentImport(files);
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
  files: AgentImportFile[],
  includeSecrets: boolean,
): Promise<Built> {
  const base = parsePlan(files);
  const taken = await takenNames(services.prisma, actor);
  const plan = resolveAgentImportNames(base, taken);
  const folder =
    base.source === "document" ? null : readAgentImportFolder(files, { includeSecrets });
  const routineInputs = new Map<string, CreateRoutineInputType>();
  const mcpConfigs = new Map<string, ImportedMcpServer & { slug: string }>();
  if (!folder) return { plan, settings: null, routineInputs, mcpConfigs };
  const settings = readAgentImportSettings(folder, { includeSecrets });

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
    return { id: server.id, title: server.title, name: slug, content: server.content };
  });

  const saved = (
    await services.prisma.user.findUnique({
      where: { id: actor.userId },
      select: { timezone: true },
    })
  )?.timezone;
  const fallbackZone = saved && isValidTimeZone(saved) ? saved : "UTC";
  const routines = settings.routines.map((routine) => {
    const timezone = routine.timezone ?? fallbackZone;
    routineInputs.set(
      routine.id,
      CreateRoutineInput.parse({
        // Replaced by the new bot's id when the routine is written.
        botId: "pending",
        name: routine.name,
        prompt: routine.prompt,
        crons: [routine.cron],
        timezone,
        active: routine.active,
      }),
    );
    return {
      id: routine.id,
      title: routine.title,
      content: `${routine.cron} (${timezone})\n\n${routine.prompt}`,
    };
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
  files: AgentImportFile[],
  includeSecrets: boolean,
): Promise<AgentImportPlan> {
  return (await buildPlan(services, actor, files, includeSecrets)).plan;
}

/** Items of `items` whose ids were selected, in plan order; unknown or repeated ids fail. */
function selected<T extends { id: string }>(items: T[], ids: string[]): T[] {
  const known = new Set(items.map((item) => item.id));
  const chosen = new Set(ids);
  if (chosen.size !== ids.length || ids.some((id) => !known.has(id))) {
    throw new ORPCError("BAD_REQUEST", { message: "The selection does not match the files." });
  }
  return items.filter((item) => chosen.has(item.id));
}

/**
 * Creates the bot from re-read files (nothing is staged between preview and create).
 * Validation and API key connections come first, then one transaction writes the bot,
 * memory, skills, MCP servers and routines; health checks and schedules start after it.
 */
export async function createImportedBot(
  services: AgentImportServices,
  actor: Actor,
  input: AgentImportCreateInput,
  signal?: AbortSignal,
): Promise<Bot> {
  const { plan, settings, routineInputs, mcpConfigs } = await buildPlan(
    services,
    actor,
    input.files,
    input.includeSecrets,
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
    if (!model || !(model.status === "ready" || (model.status === "needs_key" && keyed))) {
      throw new ORPCError("BAD_REQUEST", { message: "Connect this model's provider first." });
    }
  }
  for (const routine of routines) {
    services.assertRoutineSchedule(routine);
    services.routineNextRunAt(routine);
  }

  // Keys are account connections, saved through `models.connect` (verified and encrypted).
  for (const key of keys) {
    if (await services.hasModelConnection(actor, key.provider)) continue;
    const apiKey = settings?.keyValues.get(key.provider);
    if (!apiKey) continue;
    await services.connectModel(
      actor,
      ModelConnectInputSchema.parse({ provider: key.provider, apiKey }),
      signal,
    );
  }
  if (model) {
    const error = await services.validateBotModel(actor, model.provider, model.modelId);
    if (error) throw new ORPCError("BAD_REQUEST", { message: error });
  }
  const prepared: {
    config: McpServerConfigInput;
    stored: Stored;
    allowedTools: string[] | null;
  }[] = [];
  for (const server of servers) {
    const config = { ...server.config, slug: server.slug };
    prepared.push({
      config,
      stored: await services.prepareMcpServer(actor, config),
      allowedTools: server.allowedTools,
    });
  }

  const serverRows: McpServerRow[] = [];
  const routineRows: Routine[] = [];
  const bot = await services.createBot(actor, {
    name: input.name,
    title: "",
    description: "",
    instructions,
    notifyOnFinish: true,
    computerMode: input.computerMode,
    modelProvider: model?.provider ?? null,
    modelId: model?.modelId ?? null,
    seed: async (tx, botId) => {
      // Names are checked again under the creation lock: the preview may be stale.
      const resolved = resolveAgentImportNames(plan, await takenNames(tx, actor));
      const owner = { spaceId: actor.spaceId, userId: actor.userId };
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
      }
      for (const item of resolved.skills.filter((skill) => skillIds.includes(skill.id))) {
        await tx.agentSkill
          .create({
            data: {
              ...owner,
              name: item.name,
              description: item.description,
              content: item.content,
              source: "user",
            },
          })
          .catch((error: unknown) => {
            if (isUniqueViolation(error)) {
              throw new ORPCError("CONFLICT", {
                message: "A skill with that name was just added. Try again.",
              });
            }
            throw error;
          });
      }
      for (const { config, stored, allowedTools } of prepared) {
        const row = await services
          .insertMcpServer(tx, actor, config, stored)
          .catch(conflict("An MCP server with that name was just added. Try again."));
        await tx.botMcpServer.create({
          data: {
            ...owner,
            botId,
            serverId: row.id,
            allowAllTools: allowedTools === null,
            allowedTools: allowedTools ?? [],
          },
        });
        serverRows.push(row);
      }
      for (const routine of routines) {
        const routineInput = { ...routine, botId };
        routineRows.push(
          await tx.routine.create({
            data: services.routineRowData(
              actor,
              routineInput,
              services.routineNextRunAt(routineInput),
            ),
          }),
        );
      }
    },
  });
  for (const row of serverRows) await services.announceMcpServer(row, actor);
  const thread = bot.threadId ? { id: bot.threadId } : null;
  for (const row of routineRows) await services.announceRoutine(actor, { id: bot.id, thread }, row);
  return bot;
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
