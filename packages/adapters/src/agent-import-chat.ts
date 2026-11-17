import { createHash } from "node:crypto";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { createAdapterContext } from "@rakazo/adapter-kit";
import type { Actor, AgentImportPlan, McpServerConfigInput } from "@rakazo/contracts";
import {
  AgentImportCreateInput,
  BOT_NAME_MAX_LENGTH,
  ConnectionSetupError,
  GROK_BOT_EXPORT_MAX_LENGTH,
  GROK_BOT_EXPORT_PATH,
} from "@rakazo/contracts";
import type { GrokBot } from "@rakazo/core";
import {
  agentImportHeldBack,
  ClientError,
  GROK_BOT_REPLY_MAX_LENGTH,
  GrokBotExportError,
  grokBotExportJson,
  parseGrokBotExport,
} from "@rakazo/core";
import {
  createRepos,
  findModelCredential,
  Prisma,
  storedMessageBlocks,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { z } from "zod";
import {
  AGENT_EXPORT_CHANGED,
  AGENT_EXPORT_NOT_FOUND,
  AGENT_IMPORT_FAILED,
  AGENT_IMPORT_RESULT_NOTE,
  agentExportSharedName,
  agentExportUnknownBots,
  agentExportUnreadable,
  importNeedsText,
  LEFT_OUT_BLOCKED,
  LEFT_OUT_FOR_REVIEW,
  SERVER_ADDRESS_REFUSED,
  skippedText,
} from "./agent-import-chat.prompt.js";
import type { AgentImportServices } from "./agent-import-write.js";
import { createImportedBot, previewAgentImport } from "./agent-import-write.js";
import type { FleetCardSummary } from "./approval-ask.js";
import type { ExecutorDeps } from "./executor-deps.js";
import { insertMcpServerRow } from "./mcp-server-rows.js";
import { buildMcpCredentialBlob } from "./mcp-server-tool.js";
import { assertNoMcpEndpointCredential, assertSafeRemoteUrl } from "./remote-mcp.js";
import {
  announceRoutineRow,
  assertRoutineSchedule,
  routineNextRunAt,
  routineRowData,
} from "./routine-rows.js";

/**
 * import_agents: an agent export the owner sends in chat becomes bots through the same import
 * the Settings flow runs. Only the run's own source message is read, never text the model wrote.
 */

type RunScope = {
  spaceId: string;
  userId: string;
  threadId: string;
  sourceMessageId: string | null;
};

/** Text attachments an export may come in: the `.json` file a Bot writes, or plain text. */
const EXPORT_FILE = /^(?:application\/json|text\/)/;

/** The text of the message that started this run, and of its attached text files. */
export async function readRunAgentExport(
  deps: Pick<ExecutorDeps, "prisma" | "artifacts">,
  run: RunScope,
  context: AdapterContext,
): Promise<string> {
  if (!run.sourceMessageId) return "";
  const source = await deps.prisma.message.findUnique({
    where: { id: run.sourceMessageId },
    select: { id: true, threadId: true, role: true, blocks: true },
  });
  if (!source || source.threadId !== run.threadId || source.role !== "user") return "";
  const parts: string[] = [];
  let length = 0;
  for (const block of storedMessageBlocks(source)) {
    if (block.kind === "text") {
      parts.push(block.text);
      length += block.text.length;
      continue;
    }
    if (block.kind !== "file" || !deps.artifacts) continue;
    const fileName = typeof block.name === "string" ? block.name : "";
    if (!EXPORT_FILE.test(String(block.mimeType)) && !fileName.toLowerCase().endsWith(".json"))
      continue;
    // A file that would take the text past the size an export may have is not one.
    if (length + block.size > GROK_BOT_REPLY_MAX_LENGTH) continue;
    const row = await deps.prisma.artifact.findFirst({
      where: { id: block.artifactId, spaceId: run.spaceId },
      select: { storageKey: true },
    });
    if (!row) continue;
    let bytes: Uint8Array;
    try {
      bytes = await deps.artifacts.get(row.storageKey, context);
    } catch (error) {
      // A file that cannot be read is left out; the text and other files may hold the export.
      if (context.signal?.aborted) throw error;
      getLogger().warn("agent export attachment could not be read", {
        "artifact.id": block.artifactId,
      });
      continue;
    }
    const text = new TextDecoder().decode(bytes);
    parts.push(text);
    length += text.length;
  }
  return parts.join("\n\n");
}

const digestOf = (text: string) => createHash("sha256").update(text).digest("hex");

type Prepared =
  | { ok: true; canonical: Record<string, unknown>; summary: FleetCardSummary }
  | { ok: false; error: string };

function readExport(text: string): GrokBot[] | { error: string } {
  if (!text.trim()) return { error: AGENT_EXPORT_NOT_FOUND };
  try {
    return parseGrokBotExport(text);
  } catch (error) {
    if (error instanceof GrokBotExportError) return { error: agentExportUnreadable(error.code) };
    throw error;
  }
}

const savedName = (bot: GrokBot) => bot.name.slice(0, BOT_NAME_MAX_LENGTH);
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Resolves the named bots in the export now, so the card shows what will be created and the
 * approved request is pinned to this export by its digest.
 */
export function prepareAgentImportRequest(
  exportText: string,
  args: Record<string, unknown>,
): Prepared {
  const requested = Array.isArray(args.bot_names)
    ? args.bot_names.filter((name): name is string => typeof name === "string")
    : [];
  const names = [
    ...new Map(
      requested
        .map((name) => name.trim())
        .filter(Boolean)
        .map((name) => [name.toLowerCase(), name]),
    ).values(),
  ];
  if (!names.length) return { ok: false, error: "Pass bot_names: the bots to import." };
  const bots = readExport(exportText);
  if ("error" in bots) return { ok: false, error: bots.error };
  const chosen = names.map((name) => ({
    name,
    index: bots.findIndex((bot) => bot.name.toLowerCase() === name.toLowerCase()),
  }));
  const shared = names.find(
    (name) => bots.filter((bot) => bot.name.toLowerCase() === name.toLowerCase()).length > 1,
  );
  if (shared) return { ok: false, error: agentExportSharedName(shared) };
  const missing = chosen.filter((item) => item.index < 0).map((item) => item.name);
  if (missing.length) {
    return {
      ok: false,
      error: agentExportUnknownBots(
        missing,
        bots.map((bot) => bot.name),
      ),
    };
  }
  const picked = chosen.map(({ index }) => ({ index, bot: bots[index]! }));
  return {
    ok: true,
    canonical: {
      exportDigest: digestOf(exportText),
      bots: picked.map(({ index, bot }) => ({ index, name: bot.name })),
    },
    summary: {
      // Each bot under the name it is created with, and only the skills with text to save.
      title:
        picked.length === 1
          ? `Import ${savedName(picked[0]!.bot)}?`
          : `Import ${picked.length} bots?`,
      lines: picked.map(
        ({ bot }) =>
          `${savedName(bot)}: ${[
            count(
              bot.skills.filter((skill) => skill.instructions.trim()).length,
              "skill",
              "skills",
            ),
            count(bot.routines.length, "routine", "routines"),
            count(bot.apps.length, "app", "apps"),
          ].join(", ")}`,
      ),
    },
  };
}

/** The import's write paths for a bot's run: the same checks as Settings, without API keys. */
export function runAgentImportServices(deps: ExecutorDeps): AgentImportServices {
  const repos = createRepos(deps.prisma);
  const noKeys = () => {
    throw new ClientError("BAD_REQUEST", "API keys are imported in Settings.");
  };
  return {
    prisma: deps.prisma,
    createBot: (actor, input) =>
      withTransactionRetry(() =>
        repos.createBot(actor, {
          ...input,
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        }),
      ),
    hasModelConnection: async (actor, provider) =>
      Boolean(await findModelCredential(deps.prisma, actor, provider)),
    mcpCredentialValues: async () => null,
    connectedProviders: async () => new Set(),
    // A chat import brings no model to choose.
    validateBotModel: async () => "Choose this bot's model in its settings.",
    // Like a bot adding one, a chat import never adds a server that runs on the deployment.
    stdioAllowed: async () => () => false,
    prepareModelKey: noKeys,
    writeModelKey: noKeys,
    afterModelKey: () => undefined,
    prepareMcpServer: async (actor, input) => {
      const endpoint = "endpoint" in input ? input.endpoint : null;
      if (input.transport === "stdio" || !endpoint) {
        throw new ClientError("BAD_REQUEST", "Local MCP servers are added in Settings.");
      }
      await checkRemoteEndpoint(deps, endpoint);
      const blob = buildMcpCredentialBlob(input as McpServerConfigInput);
      return blob
        ? deps.secretStore.put(blob, createAdapterContext(actor, "mcp", "mcp.create"))
        : null;
    },
    insertMcpServer: (tx, actor, input, stored) => insertMcpServerRow(tx, actor, input, stored),
    findBot: async (actor, botId) =>
      (await repos.listBots(actor)).find((bot) => bot.id === botId) ?? null,
    routineTriggers: {
      messageProviders: deps.messagingProviders ?? [],
      email: Boolean(deps.inboundEmailDomain),
    },
    assertRoutineSchedule,
    routineNextRunAt,
    routineRowData,
    announceRoutine: (actor, bot, row) => announceRoutineRow(deps, actor, bot, row),
    notifyThread: (threadId, seq) => deps.events.notify(threadId, seq),
  };
}

/** A server address this deployment will not reach. */
const ADDRESS_REFUSED = "mcp_address_refused";

/** The address must be one a bot may reach; why it is not is the user's to fix. */
async function checkRemoteEndpoint(deps: ExecutorDeps, endpoint: string): Promise<void> {
  try {
    await assertSafeRemoteUrl(endpoint, deps.secretHttp?.resolveHostname, {
      allowPrivateEndpoint: deps.mcpAllowPrivateEndpoint === true,
    });
    assertNoMcpEndpointCredential(endpoint);
  } catch (error) {
    // Only a refused address is the user's to fix; anything else is a server failure.
    if (!(error instanceof ConnectionSetupError)) throw error;
    throw new ClientError("BAD_REQUEST", error.message, ADDRESS_REFUSED, { cause: error });
  }
}

type LeftOut = { item: string; reason: string };
export type ImportedAgent =
  | {
      name: string;
      botId: string;
      instructions: boolean;
      memory: string[];
      skills: string[];
      mcpServers: { name: string; needs: string[] }[];
      routines: { name: string; needs: string[] }[];
      leftOut: LeftOut[];
    }
  | { name: string; error: string };

/** Settings' default ticks, except that the owner's approval stands in for ticking what acts. */
function chatSelection(plan: AgentImportPlan) {
  const held = agentImportHeldBack(plan);
  const out = new Set([...held.review, ...held.blocked]);
  const kept = <T extends { id: string }>(items: T[]) => items.filter((item) => !out.has(item.id));
  const reasons = new Map<string, string>([
    ...held.review.map((id): [string, string] => [id, LEFT_OUT_FOR_REVIEW]),
    ...held.blocked.map((id): [string, string] => [id, LEFT_OUT_BLOCKED]),
  ]);
  const titled = [
    ...plan.instructions,
    ...plan.memory,
    ...plan.skills,
    ...plan.mcpServers,
    ...plan.routines,
  ];
  return {
    selection: {
      instructions: kept(plan.instructions).map((item) => item.id),
      memory: kept(plan.memory).map((item) => ({ id: item.id, destination: "bot" as const })),
      skills: kept(plan.skills).map((item) => item.id),
      model: false,
      mcpServers: kept(plan.mcpServers).map((item) => item.id),
      routines: kept(plan.routines).map((item) => item.id),
      apiKeys: [],
    },
    kept,
    leftOut: [
      ...titled.flatMap((item) =>
        reasons.has(item.id) ? [{ item: item.title, reason: reasons.get(item.id)! }] : [],
      ),
      ...plan.skipped.map((entry) => ({
        item: entry.path,
        reason: skippedText(entry.reason),
      })),
    ],
  };
}

/** Imports each approved bot; one that fails is reported and the others still come over. */
export async function importAgentsFromChat(
  deps: ExecutorDeps,
  run: RunScope,
  context: AdapterContext,
  request: Record<string, unknown>,
  effectKey: string,
  services: AgentImportServices = runAgentImportServices(deps),
): Promise<{ bots: ImportedAgent[]; note: string } | { error: string }> {
  const stored = ApprovedImportSchema.safeParse(request);
  if (!stored.success) return { error: AGENT_EXPORT_CHANGED };
  const exportText = await readRunAgentExport(deps, run, context);
  if (digestOf(exportText) !== stored.data.exportDigest) return { error: AGENT_EXPORT_CHANGED };
  const bots = readExport(exportText);
  if ("error" in bots) return bots;
  const approved = stored.data.bots;
  const actor: Actor = {
    userId: run.userId,
    spaceId: run.spaceId,
    email: "",
    isDeploymentOwner: false,
  };
  const results: ImportedAgent[] = [];
  for (const entry of approved) {
    const bot = bots[entry.index];
    const { name } = entry;
    if (!bot || bot.name !== name) {
      results.push({ name, error: AGENT_EXPORT_CHANGED });
      continue;
    }
    results.push(await importOne(services, actor, bot, `${effectKey}:${entry.index}`));
  }
  return { bots: results, note: AGENT_IMPORT_RESULT_NOTE };
}

/** The request the owner approved, as `prepareAgentImportRequest` stored it. */
const ApprovedImportSchema = z.object({
  exportDigest: z.string(),
  bots: z.array(z.object({ index: z.number().int().nonnegative(), name: z.string() })),
});

async function importOne(
  services: AgentImportServices,
  actor: Actor,
  bot: GrokBot,
  key: string,
): Promise<ImportedAgent> {
  const content = grokBotExportJson(bot);
  if (content.length > GROK_BOT_EXPORT_MAX_LENGTH) {
    return { name: bot.name, error: agentExportUnreadable("too_large") };
  }
  const files = [{ path: GROK_BOT_EXPORT_PATH, content }];
  try {
    const plan = await previewAgentImport(services, actor, {
      files,
      includeSecrets: false,
      skillFiles: {},
    });
    const chosen = chatSelection(plan);
    // The same key on a replay returns the bot this call already made.
    const keyFor = (attempt: string) => `chat:${digestOf(`${key}:${attempt}`).slice(0, 40)}`;
    const create = (selection: typeof chosen.selection, attempt: string) =>
      createImportedBot(
        services,
        actor,
        AgentImportCreateInput.parse({
          importKey: keyFor(attempt),
          files,
          name: plan.suggestedName || bot.name,
          description: plan.suggestedDescription,
          selection,
        }),
      );
    let servers = chosen.kept(plan.mcpServers);
    let leftOut = chosen.leftOut;
    const withoutServers = async (reason: string) => {
      leftOut = [...leftOut, ...servers.map((server) => ({ item: server.title, reason }))];
      servers = [];
      return create({ ...chosen.selection, mcpServers: [] }, "without-servers");
    };
    // A replay finds the bot an earlier attempt made without its servers before trying again.
    const earlier = await services.prisma.agentImport.findFirst({
      where: { spaceId: actor.spaceId, userId: actor.userId, importKey: keyFor("without-servers") },
      select: { id: true },
    });
    let created: Awaited<ReturnType<typeof create>>;
    if (earlier) created = await withoutServers(SERVER_ADDRESS_REFUSED);
    else {
      try {
        created = await create(chosen.selection, "all");
      } catch (error) {
        // An address this server refuses would keep the whole bot out; the bot comes without
        // its servers instead, and they are reported. Settings lets the user untick one.
        if (!(error instanceof ClientError) || error.code !== ADDRESS_REFUSED) throw error;
        created = await withoutServers(error.message);
      }
    }
    return {
      name: created.name,
      botId: created.id,
      instructions: chosen.selection.instructions.length > 0,
      memory: chosen.kept(plan.memory).map((item) => item.path),
      skills: chosen.kept(plan.skills).map((item) => item.name),
      mcpServers: servers.map((item) => ({ name: item.name, needs: importNeedsText(item.status) })),
      routines: chosen.kept(plan.routines).map((item) => ({
        name: item.title,
        needs: importNeedsText(item.status),
      })),
      leftOut,
    };
  } catch (error) {
    if (error instanceof ClientError) return { name: bot.name, error: error.message };
    // The other bots still come over; this one is reported, and the failure logged.
    getLogger().error("chat agent import failed", error);
    return { name: bot.name, error: AGENT_IMPORT_FAILED };
  }
}
