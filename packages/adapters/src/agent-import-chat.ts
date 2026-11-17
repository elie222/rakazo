import { createHash } from "node:crypto";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { createAdapterContext } from "@rakazo/adapter-kit";
import type { Actor, AgentImportPlan, McpServerConfigInput } from "@rakazo/contracts";
import {
  AgentImportCreateInput,
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
import {
  AGENT_EXPORT_CHANGED,
  AGENT_EXPORT_NOT_FOUND,
  AGENT_IMPORT_RESULT_NOTE,
  agentExportUnknownBots,
  agentExportUnreadable,
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
    if (!EXPORT_FILE.test(block.mimeType) && !block.name.toLowerCase().endsWith(".json")) continue;
    // Past the size an export may have, it is refused as too large without reading more.
    if (length + block.size > GROK_BOT_REPLY_MAX_LENGTH) return "x".repeat(length + block.size);
    const row = await deps.prisma.artifact.findFirst({
      where: { id: block.artifactId, spaceId: run.spaceId },
      select: { storageKey: true },
    });
    if (!row) continue;
    const text = new TextDecoder().decode(await deps.artifacts.get(row.storageKey, context));
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
  const names = [...new Set(requested.map((name) => name.trim()).filter(Boolean))];
  if (!names.length) return { ok: false, error: "Pass bot_names: the bots to import." };
  const bots = readExport(exportText);
  if ("error" in bots) return { ok: false, error: bots.error };
  const chosen = names.map((name) => ({
    name,
    index: bots.findIndex((bot) => bot.name.toLowerCase() === name.toLowerCase()),
  }));
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
      title:
        picked.length === 1 ? `Import ${picked[0]!.bot.name}?` : `Import ${picked.length} bots?`,
      lines: picked.map(
        ({ bot }) =>
          `${bot.name}: ${[
            count(bot.skills.length, "skill", "skills"),
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

/** The address must be one a bot may reach; why it is not is the user's to fix. */
async function checkRemoteEndpoint(deps: ExecutorDeps, endpoint: string): Promise<void> {
  try {
    await assertSafeRemoteUrl(endpoint, deps.secretHttp?.resolveHostname, {
      allowPrivateEndpoint: deps.mcpAllowPrivateEndpoint === true,
    });
    assertNoMcpEndpointCredential(endpoint);
  } catch (error) {
    throw new ClientError(
      "BAD_REQUEST",
      error instanceof Error ? error.message : "Invalid MCP endpoint",
      "BAD_REQUEST",
      { cause: error },
    );
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
      mcpServers: string[];
      routines: { name: string; needs: string[] }[];
      leftOut: LeftOut[];
    }
  | { name: string; error: string };

const NEED_TEXT: Record<string, string> = {
  turn_on: "turn it on",
  webhook: "point its source at the webhook address the routine shows",
  email_address: "give the bot an email address",
};

const SKIP_TEXT: Record<string, string> = {
  unsupported: "not supported here",
  reconnect: "connect it again here",
  invalid_skill: "not a readable skill",
  invalid_file: "could not be read",
};

/** Settings' default ticks, except that the owner's approval stands in for ticking what acts. */
function chatSelection(plan: AgentImportPlan) {
  const held = agentImportHeldBack(plan);
  const out = new Set([...held.review, ...held.blocked]);
  const kept = <T extends { id: string }>(items: T[]) => items.filter((item) => !out.has(item.id));
  const reasons = new Map<string, string>([
    ...held.review.map((id): [string, string] => [
      id,
      "looks like it contains a key, or is an unchanged default",
    ]),
    ...held.blocked.map((id): [string, string] => [id, "cannot run here"]),
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
        reason: SKIP_TEXT[entry.reason] ?? entry.reason,
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
  const exportText = await readRunAgentExport(deps, run, context);
  if (digestOf(exportText) !== request.exportDigest) return { error: AGENT_EXPORT_CHANGED };
  const bots = readExport(exportText);
  if ("error" in bots) return bots;
  const approved = Array.isArray(request.bots)
    ? (request.bots as { index?: unknown; name?: unknown }[])
    : [];
  const actor: Actor = {
    userId: run.userId,
    spaceId: run.spaceId,
    email: "",
    isDeploymentOwner: false,
  };
  const results: ImportedAgent[] = [];
  for (const entry of approved) {
    const bot = typeof entry.index === "number" ? bots[entry.index] : undefined;
    const name = String(entry.name ?? "");
    if (!bot || bot.name !== name) {
      results.push({ name, error: AGENT_EXPORT_CHANGED });
      continue;
    }
    results.push(await importOne(services, actor, bot, `${effectKey}:${entry.index}`));
  }
  return { bots: results, note: AGENT_IMPORT_RESULT_NOTE };
}

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
    const { selection, kept, leftOut } = chatSelection(plan);
    // The same key on a replay returns the bot this call already made.
    const created = await createImportedBot(
      services,
      actor,
      AgentImportCreateInput.parse({
        importKey: `chat:${digestOf(key).slice(0, 40)}`,
        files,
        name: plan.suggestedName || bot.name,
        description: plan.suggestedDescription,
        selection,
      }),
    );
    return {
      name: created.name,
      botId: created.id,
      instructions: selection.instructions.length > 0,
      memory: kept(plan.memory).map((item) => item.path),
      skills: kept(plan.skills).map((item) => item.name),
      mcpServers: kept(plan.mcpServers).map((item) => item.name),
      routines: kept(plan.routines).map((item) => ({
        name: item.title,
        needs:
          item.status.kind === "needs_setup"
            ? item.status.needs.map((need) =>
                need.kind === "chat_app"
                  ? `connect the bot to ${need.provider}`
                  : (NEED_TEXT[need.kind] ?? need.kind),
              )
            : [],
      })),
      leftOut,
    };
  } catch (error) {
    if (error instanceof ClientError) return { name: bot.name, error: error.message };
    throw error;
  }
}
