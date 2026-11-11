import { createHash, randomUUID } from "node:crypto";
import type {
  AdapterContext,
  DurableMemoryScope,
  SemanticMemoryConversationRequest,
  SemanticMemoryProvider,
  SemanticMemoryPurgeHistoryRequest,
  SemanticMemoryRecallRequest,
  SemanticMemoryReflectRequest,
  SemanticMemoryResponse,
  SemanticMemoryResult,
  SemanticMemorySaveRequest,
} from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import type { HindsightConnectionConfig } from "./hindsight-client.js";
import {
  deleteHindsightDocument,
  HINDSIGHT_APPEND_REFUSED,
  HINDSIGHT_CLOUD_BASE_URL,
  HINDSIGHT_RECALL_TIMEOUT_MS,
  hindsightBankExists,
  hindsightOperationStatus,
  listHindsightDocumentIdsByTag,
  probeHindsightKey,
  recallHindsight,
  reflectHindsight,
  retainHindsight,
  retryHindsightOperation,
} from "./hindsight-client.js";
import {
  assertLocalServiceBaseUrlSync,
  LocalServiceHost,
  parseServiceBaseUrl,
  pinLocalServiceHost,
} from "./local-service-endpoint.js";
import type { ResolveHostname } from "./network-address.js";
import { egressRefused } from "./network-address.js";
import { MemoryProviderPrivateEndpointRequiredError } from "./serenity-memory-provider.js";
import { truncateUtf8 } from "./utf8.js";

export const HINDSIGHT_PROVIDER_ID = "hindsight";

const MAX_CONTENT_BYTES = 32_768;
/** Longest recall query sent. */
const MAX_QUERY_CHARS = 800;
/** Most tokens of recalled memory asked for. */
const RECALL_MAX_TOKENS = 4_096;
const MAX_RECALL_BANKS = 10;
const RECALL_BANK = /^[^\s/?#%\\,]{1,256}$/;
/** A failing extra bank is skipped this long; recall and writes cool down separately. */
const EXTRA_BANK_COOLDOWN_MS = 5 * 60_000;
/** An extra bank still silent after this much of the recall timeout counts as failing. */
const EXTRA_BANK_RECALL_TIMEOUT_MS = HINDSIGHT_RECALL_TIMEOUT_MS * 0.8;
/** Purge lists a conversation's per-turn documents a page at a time, at most this many pages. */
const MAX_PURGE_PAGES = 50;
const RECALL_BUDGETS = ["low", "mid", "high"];
const DEFAULT_RECALL_BUDGET = "mid";
const RECALL_TYPES = ["observation", "observation,world,experience"];
const DEFAULT_RECALL_TYPES = "observation";
/** With skipUnrelated, the server drops results its reranker scores below this. */
const MIN_RERANKER_SCORE = 0.25;

type BankUse = "recall" | "write";

/** Per process: when each failing extra bank may be asked again. Kept after expiry until it answers. */
const bankCooldowns = new Map<string, number>();
/** Per process: banks that refused to append because they keep no document text. */
const banksWithoutAppend = new Set<string>();
/** A failed operation is re-queued on the server at most this many times. */
const OPERATION_RETRIES = 3;
/** Per process: how often each failed operation was re-queued. */
const operationRetries = new Map<string, number>();

function bankKey(connection: string, bank: string, use?: BankUse): string {
  return use ? `${connection}\n${bank}\n${use}` : `${connection}\n${bank}`;
}

function coolingDown(connection: string, bank: string, use: BankUse): boolean {
  return (bankCooldowns.get(bankKey(connection, bank, use)) ?? 0) > Date.now();
}

/** Starts a cooldown for a failing extra bank, or ends one for an answering bank. */
function noteExtraBank(connection: string, bank: string, use: BankUse, answered: boolean): void {
  const key = bankKey(connection, bank, use);
  const wasDown = bankCooldowns.has(key);
  if (answered) {
    if (!wasDown) return;
    bankCooldowns.delete(key);
    getLogger().info("Hindsight bank is answering again", { bank });
    return;
  }
  bankCooldowns.set(key, Date.now() + EXTRA_BANK_COOLDOWN_MS);
  if (!wasDown) {
    getLogger().warn("Hindsight bank is not answering; skipping it for five minutes", { bank });
  }
}

/** Test-only: forgets every bank's cooldown and append refusal. */
export function resetHindsightBankState(): void {
  bankCooldowns.clear();
  banksWithoutAppend.clear();
  operationRetries.clear();
}

/** "A", "A and B", "A, B and C". */
function joinNames(names: string[]): string {
  return names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function conversationContext(request: SemanticMemoryConversationRequest): string {
  const speakers = [
    ...new Set(request.turns.flatMap((turn) => (turn.speaker ? [turn.speaker] : []))),
  ];
  if (request.conversation === "group") {
    return `Group chat in Rakazo with ${request.userName} and the AI assistants ${joinNames([request.botName, ...speakers])}`;
  }
  if (speakers.length) {
    return `Messages in Rakazo between the AI assistants ${joinNames([request.botName, ...speakers])}, working for ${request.userName}`;
  }
  return `Chat in Rakazo between ${request.userName} and ${request.botName}, an AI assistant`;
}

/**
 * Local mode reaches the server network, so the operator must authorize private endpoints.
 * Fails closed: any mode other than an absent one or "cloud" needs the owner.
 */
export function hindsightRequiresPrivateEndpoint(settings: Record<string, string>): boolean {
  return settings.mode !== undefined && settings.mode !== "cloud";
}

interface HindsightOptions {
  /** Other apps' banks, recalled read-only after the bot's own. */
  recallBanks: string[];
  retainConversations: boolean;
  /** Off: the bot recalls only through its memory tools. */
  autoRecall: boolean;
  recallBudget: string;
  recallTypes: string;
  /** Asks the server to drop results the reranker scores under MIN_RERANKER_SCORE. */
  skipUnrelated: boolean;
}

function parseRecallBanks(value: string | undefined): string[] {
  const banks = [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((bank) => bank.trim())
        .filter(Boolean),
    ),
  ];
  if (banks.some((bank) => !RECALL_BANK.test(bank))) {
    throw new Error("recallBanks may not contain spaces, /, ?, #, % or \\");
  }
  if (banks.some((bank) => bank === "." || bank === "..")) {
    throw new Error("recallBanks may not include . or ..");
  }
  // Rakazo's own banks are recalled automatically; another Space's must never be named.
  if (banks.some((bank) => bank.startsWith("rakazo-"))) {
    throw new Error("recallBanks may not include banks named rakazo-…");
  }
  if (banks.length > MAX_RECALL_BANKS) throw new Error("recallBanks may list at most 10 banks");
  return banks;
}

function parseHindsightConnection(
  settings: Record<string, string>,
  credentials: Record<string, string>,
): { connection: HindsightConnectionConfig; options: HindsightOptions; local: boolean } {
  const mode = settings.mode ?? "cloud";
  if (mode !== "cloud" && mode !== "local") throw new Error("mode must be cloud or local");
  const local = mode === "local";
  const baseUrl = local ? settings.baseUrl?.trim() : HINDSIGHT_CLOUD_BASE_URL;
  if (!baseUrl) throw new Error("baseUrl is required");
  if (local) {
    // The cloud origin takes the unpinned cloud transport, so it cannot be a local endpoint.
    if (parseServiceBaseUrl(baseUrl).origin === HINDSIGHT_CLOUD_BASE_URL) {
      throw new Error("Local mode cannot use the Hindsight Cloud URL.");
    }
    assertLocalServiceBaseUrlSync(baseUrl);
  }
  const apiKey = credentials.apiKey?.trim() ?? "";
  const keyFits = apiKey.length >= 8 && apiKey.length <= 4096;
  if (!local && !keyFits) throw new Error("apiKey must contain 8–4096 characters");
  // A self-hosted server runs without authentication by default.
  if (local && apiKey !== "" && !keyFits) {
    throw new Error("apiKey must be empty or contain 8–4096 characters");
  }
  const recallBudget = settings.recallBudget ?? DEFAULT_RECALL_BUDGET;
  if (!RECALL_BUDGETS.includes(recallBudget)) {
    throw new Error("recallBudget must be low, mid or high");
  }
  const recallTypes = settings.recallTypes ?? DEFAULT_RECALL_TYPES;
  if (!RECALL_TYPES.includes(recallTypes)) {
    throw new Error("recallTypes must be observation or observation,world,experience");
  }
  return {
    connection: { baseUrl, apiKey },
    options: {
      recallBanks: parseRecallBanks(settings.recallBanks),
      retainConversations: settings.retainConversations !== "false",
      autoRecall: settings.autoRecall !== "false",
      recallBudget,
      recallTypes,
      skipUnrelated: settings.skipUnrelated === "true",
    },
    local,
  };
}

export async function prepareHindsightConnection(
  settings: Record<string, string>,
  credentials: Record<string, string>,
  options?: {
    allowPrivateEndpoint?: boolean;
    resolveHostname?: ResolveHostname;
    fetch?: typeof globalThis.fetch;
  },
): Promise<{ settings: Record<string, string>; credentials: Record<string, string> }> {
  const { connection, options: parsed, local } = parseHindsightConnection(settings, credentials);
  // Loopback needs no DNS pin, so refuse non-owners here before any request is sent.
  if (local && options?.allowPrivateEndpoint !== true) {
    throw egressRefused(
      URL.parse(connection.baseUrl)?.hostname ?? "",
      new MemoryProviderPrivateEndpointRequiredError(),
    );
  }
  const pinnedAddresses = local
    ? await pinLocalServiceHost(connection.baseUrl, options)
    : undefined;
  const probeConnection: HindsightConnectionConfig = {
    ...connection,
    fetch: options?.fetch,
    resolveHostname: options?.resolveHostname,
    ...(pinnedAddresses ? { pinnedAddresses } : {}),
  };
  const probe = await probeHindsightKey(probeConnection);
  if (!probe.ok) throw new Error(probe.error);
  const { recallBanks, retainConversations, autoRecall, recallBudget, recallTypes, skipUnrelated } =
    parsed;
  // The bots' own banks are created on first write, but another app's must already be there.
  for (const bank of recallBanks) {
    const exists = await hindsightBankExists(probeConnection, bank);
    if (!exists.ok) throw new Error(exists.error);
    if (!exists.value) throw new Error(`Hindsight bank "${bank}" was not found.`);
  }
  return {
    settings: {
      ...(local ? { mode: "local", baseUrl: connection.baseUrl } : {}),
      ...(recallBanks.length ? { recallBanks: recallBanks.join(",") } : {}),
      ...(retainConversations ? {} : { retainConversations: "false" }),
      ...(autoRecall ? {} : { autoRecall: "false" }),
      ...(recallBudget === DEFAULT_RECALL_BUDGET ? {} : { recallBudget }),
      ...(recallTypes === DEFAULT_RECALL_TYPES ? {} : { recallTypes }),
      ...(skipUnrelated ? { skipUnrelated: "true" } : {}),
    },
    credentials: { apiKey: connection.apiKey },
  };
}

export function createHindsightProvider(
  settings: Record<string, string>,
  credentials: Record<string, string>,
): SemanticMemoryProvider {
  const { connection, options } = parseHindsightConnection(settings, credentials);
  return new HindsightMemoryProvider(connection, options, settings.mode === "local");
}

/** Every bot keeps its own bank. */
function ownBank(spaceId: string, botId: string): string {
  return `rakazo-${spaceId}-${botId}`;
}

/** The Space's team bank, which bots that share memory also write to and recall from. */
function teamBank(spaceId: string): string {
  return `rakazo-${spaceId}`;
}

function writeBanks(spaceId: string, botId: string, scope: DurableMemoryScope): string[] {
  const own = ownBank(spaceId, botId);
  return scope === "shared" ? [own, teamBank(spaceId)] : [own];
}

/** One appended document per conversation history. */
function sessionId(threadId: string, generation: number, botId: string): string {
  return `rakazo-${threadId}-${generation}-${botId}`;
}

/** A stable UUID v4-shaped digest, so a retried job reuses the same operation id. */
function operationUuid(key: string): string {
  const h = createHash("sha256").update(key).digest("hex");
  const variant = ((Number.parseInt(h.charAt(16), 16) & 3) | 8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** An operation a submitted turn waits on; the team bank's failing never fails the turn. */
interface PendingOperation {
  bank: string;
  operationId: string;
  team?: true;
}

const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Undefined unless every entry names an operation in one of this Space's banks. */
function parsePendingOperations(pending: string, spaceId: string): PendingOperation[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(pending);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
  const team = teamBank(spaceId);
  const operations: PendingOperation[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") return undefined;
    const { bank, operationId, team: isTeam } = entry as Record<string, unknown>;
    if (typeof bank !== "string" || typeof operationId !== "string") return undefined;
    if (!OPERATION_ID.test(operationId)) return undefined;
    if (isTeam === true ? bank !== team : isTeam !== undefined || !bank.startsWith(`${team}-`)) {
      return undefined;
    }
    operations.push({ bank, operationId, ...(isTeam === true ? { team: true as const } : {}) });
  }
  return operations;
}

/** Python counts code points; UTF-16 length is never smaller, so this stays under the limit. */
function truncateChars(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const end = /[\uD800-\uDBFF]/.test(value.charAt(maxChars - 1)) ? maxChars - 1 : maxChars;
  return value.slice(0, end);
}

export class HindsightMemoryProvider implements SemanticMemoryProvider {
  private readonly localHost?: LocalServiceHost;
  private readonly stateKey: string;
  readonly retainConversation?: (
    request: SemanticMemoryConversationRequest,
    context: AdapterContext,
  ) => Promise<SemanticMemoryResponse<{ pending?: string }>>;

  constructor(
    private readonly connection: HindsightConnectionConfig,
    private readonly options: HindsightOptions,
    local: boolean,
  ) {
    // Tenants sharing one server keep separate bank state: the key's digest tells them apart.
    const keyDigest = createHash("sha256").update(connection.apiKey).digest("hex").slice(0, 16);
    this.stateKey = `${keyDigest}\n${connection.baseUrl}`;
    if (local) {
      this.localHost = new LocalServiceHost(connection.baseUrl, connection.resolveHostname);
    }
    if (options.retainConversations) {
      this.retainConversation = (request, context) => this.retainTurn(request, context);
    }
  }

  /** Local hosts are checked and pinned before the first request, then reused. */
  private async connectionForRequest(): Promise<SemanticMemoryResponse<HindsightConnectionConfig>> {
    if (!this.localHost) return { ok: true, value: this.connection };
    const blocked = await this.localHost.block();
    if (blocked) return { ok: false, error: blocked };
    return { ok: true, value: this.localHost.withPin(this.connection) };
  }

  describe() {
    return {
      id: HINDSIGHT_PROVIDER_ID,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        recall: true,
        save: true,
        purgeHistory: true,
        // Clearing a chat purges what was learned there even after learning is turned off.
        purgesByThread: true,
        sharedScope: true,
        ...(this.options.autoRecall
          ? { recallEachRun: true as const }
          : { recallOnRequestOnly: true as const }),
      } as const,
    };
  }

  /**
   * Recalls the bot's write banks, then the other apps' banks, all at once. The bot's own bank
   * failing fails the recall; any other bank failing is skipped. A result whose text an earlier
   * bank already returned is dropped.
   */
  async recall(
    request: SemanticMemoryRecallRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse<SemanticMemoryResult[]>> {
    const query = request.query.trim();
    if (!query) return { ok: true, value: [] };
    const connection = await this.connectionForRequest();
    if (!connection.ok) return connection;
    const written = writeBanks(context.spaceId, request.botId, request.scope);
    const banks = [
      ...written,
      ...this.options.recallBanks.filter((bank) => !written.includes(bank)),
    ];
    const body = {
      query: truncateChars(query, MAX_QUERY_CHARS),
      budget: this.options.recallBudget,
      max_tokens: RECALL_MAX_TOKENS,
      types: this.options.recallTypes.split(","),
      ...(this.options.skipUnrelated ? { min_scores: { reranker: MIN_RERANKER_SCORE } } : {}),
    };
    const stateKey = this.stateKey;
    const found = await Promise.all(
      banks.map(async (bank, index) => {
        // The bot's own bank is never cooled down: its failure fails the recall.
        if (index === 0) return recallHindsight(connection.value, bank, body, context.signal);
        if (coolingDown(stateKey, bank, "recall")) return undefined;
        const answer = await recallHindsight(
          connection.value,
          bank,
          body,
          context.signal,
          EXTRA_BANK_RECALL_TIMEOUT_MS,
        );
        if (!context.signal.aborted) noteExtraBank(stateKey, bank, "recall", answer.ok);
        return answer;
      }),
    );
    const results: SemanticMemoryResult[] = [];
    const seen = new Set<string>();
    for (const [index, bank] of banks.entries()) {
      const answer = found[index];
      if (!answer) continue;
      if (!answer.ok) {
        if (index === 0) return answer;
        continue;
      }
      const external = !written.includes(bank);
      const kept = answer.value.filter((memory) => !seen.has(memory.text.trim()));
      for (const memory of kept) {
        seen.add(memory.text.trim());
        results.push({
          memory: memory.text,
          score: memory.score,
          ...(memory.updatedAt ? { updatedAt: memory.updatedAt } : {}),
          ...(external
            ? { provenance: "another app via hindsight", external: true as const }
            : { provenance: "hindsight" }),
        });
      }
    }
    return { ok: true, value: results.slice(0, request.limit) };
  }

  async save(
    request: SemanticMemorySaveRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse> {
    // Compaction summaries are pre-summarized text, which Hindsight extracts poorly from.
    if (request.source.kind === "history") return { ok: true, value: undefined };
    const content = request.content.trim();
    if (!content) return { ok: false, error: "Hindsight save skipped: memory content is empty." };
    const connection = await this.connectionForRequest();
    if (!connection.ok) return connection;
    const item = {
      content: truncateUtf8(content, MAX_CONTENT_BYTES),
      context:
        "A fact a Rakazo AI assistant chose to remember about the people it works for and their work",
      timestamp: new Date().toISOString(),
    };
    const [own, ...extra] = writeBanks(context.spaceId, request.botId, request.scope);
    const write = (bank: string) =>
      retainHindsight(
        connection.value,
        bank,
        { items: [item], async: true, operation_id: randomUUID() },
        context.signal,
      );
    // A failing own bank fails the call before the team bank is touched, so a retry cannot
    // duplicate the item there; a failing team bank is logged and skipped for five minutes.
    const first = await write(own!);
    if (!first.ok) return first;
    for (const bank of extra) {
      if (coolingDown(this.stateKey, bank, "write")) continue;
      const written = await write(bank);
      noteExtraBank(this.stateKey, bank, "write", written.ok);
    }
    return { ok: true, value: undefined };
  }

  /**
   * Appends the turn to its conversation's document in each write bank. `pending` lists the
   * operations to wait on; submitting again replays the same operations. A failing own bank
   * fails the call before the team bank is touched; a failing team bank is logged and skipped for
   * five minutes.
   */
  private async retainTurn(
    request: SemanticMemoryConversationRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse<{ pending?: string }>> {
    const turns = request.turns.filter((turn) => turn.content.trim());
    const last = turns.at(-1);
    if (!last) return { ok: true, value: {} };
    const connection = await this.connectionForRequest();
    if (!connection.ok) return connection;
    const session = sessionId(request.threadId, request.generation, request.botId);
    const item = {
      content: JSON.stringify(
        turns.map((turn) => ({
          role: turn.role,
          content: `${turn.speaker ?? (turn.role === "user" ? "User" : "Assistant")}: ${truncateUtf8(turn.content, MAX_CONTENT_BYTES)}`,
          timestamp: turn.timestamp,
        })),
      ),
      context: conversationContext(request),
      timestamp: last.timestamp,
      tags: [`session:${session}`],
      observation_scopes: "shared",
    };
    const appended = { ...item, document_id: session, update_mode: "append" };
    // A bank keeping no document text stores each turn in its own document.
    const separate = { ...item, document_id: `rakazo-turn-${request.runId}` };
    const write = async (bank: string): Promise<SemanticMemoryResponse<string>> => {
      const key = bankKey(this.stateKey, bank);
      const store = async (
        stored: object,
        kind: string,
      ): Promise<SemanticMemoryResponse<string>> => {
        // One id per run and bank: a repeated call returns the original operation.
        const operationId = operationUuid(`${kind}:${request.runId}:${bank}`);
        const retained = await retainHindsight(
          connection.value,
          bank,
          { items: [stored], async: true, operation_id: operationId },
          context.signal,
        );
        return retained.ok ? { ok: true, value: operationId } : retained;
      };
      if (banksWithoutAppend.has(key)) return store(separate, "rakazo-turn-document");
      const stored = await store(appended, "rakazo-turn");
      if (stored.ok || stored.error !== HINDSIGHT_APPEND_REFUSED) return stored;
      banksWithoutAppend.add(key);
      return store(separate, "rakazo-turn-document");
    };
    const [own, ...extra] = writeBanks(context.spaceId, request.botId, request.scope);
    const first = await write(own!);
    if (!first.ok) return first;
    const operations: PendingOperation[] = [{ bank: own!, operationId: first.value }];
    for (const bank of extra) {
      if (coolingDown(this.stateKey, bank, "write")) continue;
      const written = await write(bank);
      noteExtraBank(this.stateKey, bank, "write", written.ok);
      if (written.ok) operations.push({ bank, operationId: written.value, team: true });
    }
    return { ok: true, value: { pending: JSON.stringify(operations) } };
  }

  /**
   * Checks each submitted operation once; settled once all are done, so a purge after that
   * removes the turn. A team-bank operation that fails for good is logged and skipped.
   */
  async retainedConversationSettled(
    pending: string,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse<{ settled: boolean }>> {
    const operations = parsePendingOperations(pending, context.spaceId);
    if (!operations) return { ok: false, error: "Hindsight got an invalid pending turn." };
    const connection = await this.connectionForRequest();
    if (!connection.ok) return connection;
    let settled = true;
    for (const { bank, operationId, team } of operations) {
      const done = await this.operationSettled(connection.value, bank, operationId, context.signal);
      if (!done.ok) {
        if (!team) return done;
        noteExtraBank(this.stateKey, bank, "write", false);
        continue;
      }
      if (!done.value) settled = false;
    }
    return { ok: true, value: { settled } };
  }

  /**
   * Whether the operation finished; until then deleting the conversation's document finds
   * nothing to delete. A failed operation is re-queued at most three times, then fails.
   */
  private async operationSettled(
    connection: HindsightConnectionConfig,
    bank: string,
    operationId: string,
    signal: AbortSignal,
  ): Promise<SemanticMemoryResponse<boolean>> {
    const status = await hindsightOperationStatus(connection, bank, operationId, signal);
    if (!status.ok) return status;
    const key = `${bankKey(this.stateKey, bank)}\n${operationId}`;
    if (status.value === "completed") {
      operationRetries.delete(key);
      return { ok: true, value: true };
    }
    if (status.value === "pending" || status.value === "processing") {
      return { ok: true, value: false };
    }
    if (status.value === "failed" || status.value === "cancelled") {
      const retries = operationRetries.get(key) ?? 0;
      if (retries >= OPERATION_RETRIES) {
        operationRetries.delete(key);
        return { ok: false, error: "Hindsight couldn't store the turn." };
      }
      operationRetries.set(key, retries + 1);
      const retried = await retryHindsightOperation(connection, bank, operationId, signal);
      return retried.ok ? { ok: true, value: false } : retried;
    }
    return { ok: false, error: `Hindsight could not store this turn: ${status.value}.` };
  }

  /**
   * Bots may have written either bank, so both lose the cleared conversation: its appended
   * document and any per-turn documents tagged with it.
   */
  async purgeHistory(
    request: SemanticMemoryPurgeHistoryRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse> {
    const connection = await this.connectionForRequest();
    if (!connection.ok) return connection;
    const banks = [ownBank(context.spaceId, request.botId), teamBank(context.spaceId)];
    const purge = async (bank: string, session: string): Promise<SemanticMemoryResponse> => {
      const deleted = await deleteHindsightDocument(
        connection.value,
        bank,
        session,
        context.signal,
      );
      if (!deleted.ok) return deleted;
      for (let page = 0; page < MAX_PURGE_PAGES; page++) {
        const ids = await listHindsightDocumentIdsByTag(
          connection.value,
          bank,
          `session:${session}`,
          context.signal,
        );
        if (!ids.ok) return ids;
        if (!ids.value.length) return { ok: true, value: undefined };
        for (const id of ids.value) {
          const removed = await deleteHindsightDocument(connection.value, bank, id, context.signal);
          if (!removed.ok) return removed;
        }
      }
      return { ok: false, error: "Hindsight still lists documents of this conversation." };
    };
    const purged = await Promise.all(
      [...new Set(request.generations)].flatMap((generation) =>
        banks.map((bank) => purge(bank, sessionId(request.threadId, generation, request.botId))),
      ),
    );
    const errors = purged.flatMap((result) => (result.ok ? [] : [result.error]));
    return errors.length ? { ok: false, error: errors.join("; ") } : { ok: true, value: undefined };
  }

  async reflect(
    request: SemanticMemoryReflectRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse<string>> {
    const query = request.query.trim();
    if (!query) return { ok: true, value: "" };
    const connection = await this.connectionForRequest();
    if (!connection.ok) return connection;
    return reflectHindsight(
      connection.value,
      ownBank(context.spaceId, request.botId),
      { query: truncateChars(query, MAX_QUERY_CHARS), budget: this.options.recallBudget },
      context.signal,
    );
  }
}
