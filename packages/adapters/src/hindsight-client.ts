import {
  fetchLocalService,
  type LocalServiceConnection,
  parseServiceBaseUrl,
} from "./local-service-endpoint.js";

/** Recall and retain run on the agent's critical path, so the ceiling is generous. */
const HINDSIGHT_TIMEOUT_MS = 90_000;
const MAX_MEMORY_CONTENT_CHARS = 4_000;
const MAX_RECALLED_MEMORIES = 50;
const BANK_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Hindsight serves every route under a versioned, scoped prefix. */
const API_PREFIX = "/v1/default";

export interface HindsightConnectionConfig extends LocalServiceConnection {
  bank: string;
  /** Hindsight ships without auth; a reverse proxy may add one. */
  token?: string;
}

export interface HindsightRecallItem {
  memory: string;
  score: number;
  id?: string;
  updatedAt?: string;
}

export type HindsightResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseHindsightBank(value: string): string {
  const bank = value.trim();
  if (!BANK_PATTERN.test(bank)) {
    throw new Error("bank must be 1-64 letters, digits, dots, dashes or underscores");
  }
  return bank;
}

function banksUrl(baseUrl: string, bank: string, path: string): string {
  const url = parseServiceBaseUrl(baseUrl);
  const prefix = url.pathname.replace(/\/+$/, "");
  url.pathname = `${prefix}${API_PREFIX}/banks/${encodeURIComponent(bank)}${path}`;
  return url.href;
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(HINDSIGHT_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function requestHeaders(config: HindsightConnectionConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
  };
}

function boundedLimit(limit: number): number {
  return Math.min(Math.max(1, Math.floor(limit)), MAX_RECALLED_MEMORIES);
}

function unreachable(error: unknown): string {
  return `Hindsight is unreachable: ${error instanceof Error ? error.message : String(error)}`;
}

async function post<T>(
  config: HindsightConnectionConfig,
  url: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<HindsightResult<T>> {
  try {
    const response = await fetchLocalService(config, url, {
      method: "POST",
      headers: requestHeaders(config),
      body: JSON.stringify(body),
      signal: requestSignal(signal),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return {
        ok: false,
        error: `Hindsight answered ${response.status} ${response.statusText}`.trim(),
      };
    }
    return { ok: true, value: (await response.json()) as T };
  } catch (error) {
    return { ok: false, error: unreachable(error) };
  }
}

/** Per-stage scores; the final reranker score is the best single number to rank on. */
function parseScore(scores: unknown): number {
  if (!scores || typeof scores !== "object") return 0;
  const value = (scores as { final?: unknown }).final;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseRecallResults(data: unknown): HindsightRecallItem[] {
  if (!data || typeof data !== "object") return [];
  const results = (data as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  const parsed: HindsightRecallItem[] = [];
  for (const item of results) {
    if (!item || typeof item !== "object") continue;
    const row = item as {
      id?: unknown;
      text?: unknown;
      scores?: unknown;
      mentioned_at?: unknown;
      updated_at?: unknown;
    };
    if (typeof row.text !== "string") continue;
    const memory = row.text.trim().slice(0, MAX_MEMORY_CONTENT_CHARS);
    if (!memory) continue;
    const updatedAt =
      typeof row.mentioned_at === "string"
        ? row.mentioned_at
        : typeof row.updated_at === "string"
          ? row.updated_at
          : undefined;
    parsed.push({
      memory,
      score: parseScore(row.scores),
      ...(typeof row.id === "string" ? { id: row.id } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    });
  }
  return parsed;
}

export async function recallHindsight(
  config: HindsightConnectionConfig,
  request: {
    query: string;
    tags?: string[];
    limit: number;
    maxTokens?: number;
    signal?: AbortSignal;
  },
): Promise<HindsightResult<HindsightRecallItem[]>> {
  const tags = request.tags?.filter(Boolean) ?? [];
  const result = await post<unknown>(
    config,
    banksUrl(config.baseUrl, config.bank, "/memories/recall"),
    {
      query: request.query,
      budget: "mid",
      max_tokens: request.maxTokens ?? 4_096,
      ...(tags.length > 0 ? { tags, tags_match: "any" } : {}),
    },
    request.signal,
  );
  return result.ok
    ? { ok: true, value: parseRecallResults(result.value).slice(0, boundedLimit(request.limit)) }
    : result;
}

export async function retainHindsight(
  config: HindsightConnectionConfig,
  request: {
    content: string;
    tags?: string[];
    documentId?: string;
    metadata?: Record<string, string>;
    signal?: AbortSignal;
  },
): Promise<HindsightResult<void>> {
  const content = request.content.trim();
  if (!content) return { ok: true, value: undefined };
  const result = await post<unknown>(
    config,
    banksUrl(config.baseUrl, config.bank, "/memories/"),
    {
      items: [
        {
          content: content.slice(0, MAX_MEMORY_CONTENT_CHARS * 4),
          context: "rakazo",
          ...(request.documentId ? { document_id: request.documentId } : {}),
          ...(request.tags?.length ? { tags: request.tags } : {}),
          ...(request.metadata ? { metadata: request.metadata } : {}),
        },
      ],
      async: false,
    },
    request.signal,
  );
  return result.ok ? { ok: true, value: undefined } : result;
}

/** A recall with a query matching nothing proves the bank answers without writing to it. */
export async function probeHindsight(
  config: HindsightConnectionConfig,
  signal?: AbortSignal,
): Promise<HindsightResult<void>> {
  const result = await recallHindsight(config, {
    query: "rakazo connection check",
    limit: 1,
    maxTokens: 64,
    signal,
  });
  return result.ok ? { ok: true, value: undefined } : result;
}
