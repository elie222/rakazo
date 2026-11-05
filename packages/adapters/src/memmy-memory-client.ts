import { randomUUID } from "node:crypto";
import type {
  TurnMemoryCaptureResult,
  TurnMemoryLayer,
  TurnMemorySection,
} from "@rakazo/adapter-kit";
import { fetchLocalService, LocalServiceHost } from "./local-service-endpoint.js";
import type { ResolveHostname } from "./network-address.js";
import { createSafeRemoteFetch } from "./remote-mcp.js";

/**
 * Recall stays bounded on the turn's critical path. Query extraction adds work before
 * search, so allow a 2.5-second total budget; timeout runs the turn without this context.
 * This is a caller deadline, not a guarantee about provider tail latency.
 */
export const MEMMY_SEARCH_TIMEOUT_MS = 2500;
/** Capture runs in a background job, so it can wait for Memmy's synchronous write. */
export const MEMMY_CAPTURE_TIMEOUT_MS = 10_000;
export const MEMMY_ADD_TIMEOUT_MS = 10_000;
/** Consecutive search failures that open the breaker for one base URL. */
export const MEMMY_BREAKER_THRESHOLD = 3;
export const MEMMY_BREAKER_COOLDOWN_MS = 60_000;

/** Memmy's wire layer names; the only place they meet Rakazo's layers. */
const LAYER_FROM_MEMMY: ReadonlyMap<string, TurnMemoryLayer> = new Map<string, TurnMemoryLayer>([
  ["Skill", "procedure"],
  ["L2", "policy"],
  ["L3", "environment"],
  ["L1", "episode"],
]);
const LAYER_TO_MEMMY: ReadonlyMap<TurnMemoryLayer, string> = new Map(
  [...LAYER_FROM_MEMMY].map(([memmy, layer]) => [layer, memmy]),
);

/** Pending reasons a resend cannot fix: invalid evidence or an already closed source boundary. */
const TERMINAL_PENDING_REASONS: ReadonlySet<string> = new Set([
  "identity_unresolved",
  "source_turn_boundary_unresolved",
  "source_turn_incomplete",
  "memory_add_disabled",
  "legacy_before_activation",
  "source_episode_closed",
  "source_session_closed",
  "legacy_source_turn_already_completed",
]);

export interface MemmyNamespace {
  source?: string;
  userId?: string;
  profileId?: string;
  sessionKey?: string;
}

export interface MemmySearchInput {
  query: string;
  layers: TurnMemoryLayer[];
  limit: number;
  contextBudget: number;
  /**
   * Searched in parallel inside one deadline and merged in this order, first wins on a
   * duplicate section. The breaker counts the whole search as one recall.
   */
  namespaces: MemmyNamespace[];
}

export interface MemmySearchResult {
  sections: TurnMemorySection[];
  sourceMemoryIds: string[];
}

export interface MemmySourceTurnBody {
  requestId: string;
  channel: "hook";
  source: string;
  namespace: { userId: string };
  sourceTurn: {
    source: string;
    profileId: string;
    conversationId: string;
    turnId: string;
    startedAt: string;
    completedAt: string;
    sequence?: number;
    completionEvidence: string;
  };
  query: string;
  answer: string;
  status: "succeeded";
  toolCalls: Array<{ name: string; input: string }>;
  toolResults: Array<{ name: string; output: string }>;
  sourceMemoryIds: string[];
}

export interface MemmyAddBody {
  requestId: string;
  content: string;
  layer: "L2";
  tags: string[];
  namespace: MemmyNamespace;
}

export type MemmyResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface MemmyClientOptions {
  /** Normalized, without a trailing slash. */
  baseUrl: string;
  token: string;
  /**
   * Private endpoints are checked and DNS-pinned once per client, as other local providers do.
   * Public ones are resolved and checked on every connection, so a name that later points at
   * the server's network is refused.
   */
  endpointTrust: "public" | "private";
  /** Test seams. */
  fetch?: typeof globalThis.fetch;
  resolveHostname?: ResolveHostname;
  now?: () => number;
}

interface BreakerState {
  failures: number;
  openUntil: number;
}

/** Keyed by base URL: every provider instance for one Memmy shares its health. */
const breakers = new Map<string, BreakerState>();

/** Test seam: forget breaker state between cases. */
export function resetMemmyCircuitBreakers(): void {
  breakers.clear();
}

class MemmyTimeoutError extends Error {
  constructor() {
    super("timeout");
    this.name = "MemmyTimeoutError";
  }
}

interface Deadline {
  signal: AbortSignal;
  /** Settles with a rejection when the deadline or the caller aborts. */
  aborted: Promise<never>;
  timedOut(): boolean;
  dispose(): void;
}

/**
 * setTimeout rather than AbortSignal.timeout so fake timers drive it, and a rejection race so
 * a transport that ignores its signal still cannot hold the caller past the budget.
 */
function deadline(timeoutMs: number, parent?: AbortSignal): Deadline {
  const controller = new AbortController();
  let expired = false;
  let rejectAborted: (reason: unknown) => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectAborted = reject;
  });
  // The race may never be awaited when the request wins; keep that rejection quiet.
  aborted.catch(() => undefined);
  const timer = setTimeout(() => {
    expired = true;
    const error = new MemmyTimeoutError();
    controller.abort(error);
    rejectAborted(error);
  }, timeoutMs);
  const onParentAbort = () => {
    controller.abort(parent?.reason);
    rejectAborted(parent?.reason ?? new Error("aborted"));
  };
  if (parent?.aborted) onParentAbort();
  else parent?.addEventListener("abort", onParentAbort, { once: true });
  return {
    signal: controller.signal,
    aborted,
    timedOut: () => expired,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function uniq(values: string[]): string[] {
  return [...new Set(values)];
}

function parseSearchResponse(body: unknown): MemmySearchResult | null {
  if (!isRecord(body) || !isRecord(body.debug)) return null;
  const rawSections = body.debug.sections;
  if (!Array.isArray(rawSections)) return null;
  const sections: TurnMemorySection[] = [];
  const fallbackIds: string[] = [];
  for (const raw of rawSections) {
    if (!isRecord(raw)) continue;
    const { id, content, memoryLayer } = raw;
    if (typeof id !== "string" || !id) continue;
    if (typeof content !== "string" || !content.trim()) continue;
    // Unknown layers come from a newer Memmy; the contract has no layer for them yet.
    const layer = typeof memoryLayer === "string" ? LAYER_FROM_MEMMY.get(memoryLayer) : undefined;
    if (!layer) continue;
    const sourceMemoryIds = uniq(stringArray(raw.memoryIds) ?? []);
    sections.push({ layer, id, sourceMemoryIds, content });
    fallbackIds.push(...sourceMemoryIds);
  }
  const reported = stringArray(body.debug.sourceMemoryIds);
  return { sections, sourceMemoryIds: uniq(reported ?? fallbackIds) };
}

function mergeSearchResults(results: MemmySearchResult[]): MemmySearchResult {
  const seen = new Set<string>();
  const sections: TurnMemorySection[] = [];
  for (const section of results.flatMap((result) => result.sections)) {
    if (seen.has(section.id)) continue;
    seen.add(section.id);
    sections.push(section);
  }
  return { sections, sourceMemoryIds: uniq(results.flatMap((r) => r.sourceMemoryIds)) };
}

interface Transport {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Releases per-request resources once the body has been read or abandoned. */
  close(): void;
}

function describeError(error: unknown, limit: Deadline, parent?: AbortSignal): string {
  if (limit.timedOut() || error instanceof MemmyTimeoutError) return "timeout";
  if (parent?.aborted) return "aborted";
  return "network_error";
}

/** Thin HTTP client for the three Memmy routes Rakazo uses. Never puts the token in an error. */
export class MemmyMemoryClient {
  private readonly localHost?: LocalServiceHost;
  private readonly now: () => number;

  constructor(private readonly options: MemmyClientOptions) {
    this.now = options.now ?? Date.now;
    if (options.endpointTrust === "private") {
      this.localHost = new LocalServiceHost(options.baseUrl, options.resolveHostname);
    }
  }

  get baseUrl(): string {
    return this.options.baseUrl;
  }

  private transport(): Transport {
    const localHost = this.localHost;
    if (localHost) {
      return {
        fetch: async (url, init) => {
          const blocked = await localHost.block();
          if (blocked) throw new Error(blocked);
          return fetchLocalService(
            localHost.withPin({ baseUrl: this.options.baseUrl, fetch: this.options.fetch }),
            url,
            init,
          );
        },
        close: () => undefined,
      };
    }
    // One dispatcher per request: providers are rebuilt every turn, so a long-lived one leaks.
    const safe = createSafeRemoteFetch(this.options.fetch, this.options.resolveHostname);
    return {
      fetch: (url, init) => safe(url, init),
      close: () => {
        void safe.close().catch(() => undefined);
      },
    };
  }

  private async post(
    transport: Transport,
    path: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<Response> {
    const url = `${this.options.baseUrl}${path}`;
    const init: RequestInit = {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      signal,
      // A redirect would carry the bearer token to wherever it points.
      redirect: "error",
    };
    return transport.fetch(url, init);
  }

  /** POST and read the JSON body inside one deadline. */
  private async exchange(
    path: string,
    body: unknown,
    timeoutMs: number,
    parent?: AbortSignal,
  ): Promise<
    | { kind: "response"; status: number; json: unknown; jsonOk: boolean }
    | { kind: "error"; reason: string }
  > {
    const limit = deadline(timeoutMs, parent);
    const transport = this.transport();
    try {
      const run = async () => {
        const response = await this.post(transport, path, body, limit.signal);
        let text: string | null = null;
        try {
          text = await response.text();
        } catch {
          // The status already arrived: a body that fails mid-stream is a diagnosis
          // detail, not a lost response. Dropping the status would turn a permanent
          // rejection (401/422) into a retryable transport error.
          text = null;
        }
        if (text === null) {
          // A rejection's status is the whole answer, so keep it. A success whose body
          // never arrived carries no usable payload and stays a transport failure.
          if (response.status >= 400) {
            return {
              kind: "response" as const,
              status: response.status,
              json: null,
              jsonOk: false,
            };
          }
          throw new Error("response body unavailable");
        }
        let json: unknown = null;
        let jsonOk = false;
        try {
          json = JSON.parse(text);
          jsonOk = true;
        } catch {
          jsonOk = false;
        }
        return { kind: "response" as const, status: response.status, json, jsonOk };
      };
      return await Promise.race([run(), limit.aborted]);
    } catch (error) {
      return { kind: "error", reason: describeError(error, limit, parent) };
    } finally {
      limit.dispose();
      transport.close();
    }
  }

  private breaker(): BreakerState {
    let state = breakers.get(this.options.baseUrl);
    if (!state) {
      state = { failures: 0, openUntil: 0 };
      breakers.set(this.options.baseUrl, state);
    }
    return state;
  }

  /** Recall. Fails fast while the breaker is open; a caller abort does not count as a failure. */
  async search(
    input: MemmySearchInput,
    signal?: AbortSignal,
  ): Promise<MemmyResult<MemmySearchResult>> {
    const state = this.breaker();
    if (state.openUntil > this.now()) return { ok: false, error: "circuit_open" };
    const layers = input.layers.flatMap((layer) => LAYER_TO_MEMMY.get(layer) ?? []);
    // Started together, so every namespace shares the same search budget.
    const outcomes = await Promise.all(
      input.namespaces.map((namespace) =>
        this.exchange(
          "/api/v1/memory/search",
          {
            requestId: randomUUID(),
            query: input.query,
            layers,
            limit: input.limit,
            contextBudget: input.contextBudget,
            includeInjectedContext: true,
            verbose: true,
            namespace,
          },
          MEMMY_SEARCH_TIMEOUT_MS,
          signal,
        ),
      ),
    );
    let error: string | null = null;
    const values: MemmySearchResult[] = [];
    for (const outcome of outcomes) {
      if (outcome.kind === "error") {
        error = outcome.reason;
      } else if (outcome.status < 200 || outcome.status >= 300) {
        error = `http_${outcome.status}`;
      } else if (!outcome.jsonOk) {
        error = "invalid_json";
      } else {
        const value = parseSearchResponse(outcome.json);
        if (value) values.push(value);
        else error = "invalid_response";
      }
      if (error) break;
    }
    if (error === "aborted" && signal?.aborted) return { ok: false, error };
    if (error) {
      state.failures += 1;
      if (state.failures >= MEMMY_BREAKER_THRESHOLD) {
        state.openUntil = this.now() + MEMMY_BREAKER_COOLDOWN_MS;
      }
      return { ok: false, error };
    }
    state.failures = 0;
    state.openUntil = 0;
    return { ok: true, value: mergeSearchResults(values) };
  }

  /** Capture one finished turn and classify the outcome for the job queue. */
  async complete(
    body: MemmySourceTurnBody,
    signal?: AbortSignal,
  ): Promise<TurnMemoryCaptureResult> {
    const outcome = await this.exchange(
      "/api/v1/source-turns/complete",
      body,
      MEMMY_CAPTURE_TIMEOUT_MS,
      signal,
    );
    if (outcome.kind === "error") return { status: "retryable", reason: outcome.reason };
    return classifyCaptureResponse(outcome.status, outcome.jsonOk, outcome.json);
  }

  /** Explicit durable save. */
  async add(body: MemmyAddBody, signal?: AbortSignal): Promise<MemmyResult<void>> {
    const outcome = await this.exchange("/api/v1/memory/add", body, MEMMY_ADD_TIMEOUT_MS, signal);
    if (outcome.kind === "error")
      return { ok: false, error: `Memmy save failed: ${outcome.reason}` };
    if (outcome.status < 200 || outcome.status >= 300) {
      return { ok: false, error: `Memmy save failed: HTTP ${outcome.status}` };
    }
    return { ok: true, value: undefined };
  }
}

/** Maps a source-turns/complete reply onto the capture job's retry decision. */
export function classifyCaptureResponse(
  status: number,
  jsonOk: boolean,
  json: unknown,
): TurnMemoryCaptureResult {
  if (status === 401 || status === 403) return { status: "terminal", reason: "unauthorized" };
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return { status: "retryable", reason: `http_${status}` };
  }
  if (status >= 400) {
    // 400/404/422 per contract; other 4xx (409, 413, ...) are equally a payload or route
    // problem that a resend cannot fix.
    return { status: "terminal", reason: `rejected_${status}` };
  }
  if (status < 200 || status >= 300) return { status: "retryable", reason: `http_${status}` };
  if (!jsonOk || !isRecord(json)) return { status: "retryable", reason: "invalid_json" };
  const bodyStatus = json.status;
  const reason = typeof json.reason === "string" && json.reason ? json.reason : undefined;
  switch (bodyStatus) {
    case "stored":
    case "existing":
      return { status: bodyStatus };
    case "conflict":
    case "rejected":
      return { status: "terminal", reason: reason ?? bodyStatus };
    case "pending":
      if (reason && TERMINAL_PENDING_REASONS.has(reason)) return { status: "terminal", reason };
      return { status: "retryable", reason: reason ?? "pending" };
    default:
      // A newer Memmy status: retry within the job's attempt budget rather than drop evidence.
      return {
        status: "retryable",
        reason: `unexpected_status:${typeof bodyStatus === "string" ? bodyStatus : "missing"}`,
      };
  }
}
