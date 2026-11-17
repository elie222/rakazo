import { deadlineSignal, ResponseTooLargeError } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging";
import { readBodyCapped } from "../../../web/web-ssrf.js";

export const MNEMOVERSE_BASE_URL = "https://core.mnemoverse.com/api/v1";

const MNEMOVERSE_TIMEOUT_MS = 15_000;

/** Reads and the atom lookup carry a handful of bounded memories plus small metadata. */
export const MAX_MNEMOVERSE_RESPONSE_BYTES = 1024 * 1024;

/** Mnemoverse rejects memory content longer than this. */
export const MAX_MEMORY_CONTENT_CHARS = 10_000;

/** Mnemoverse rejects a query longer than this. */
export const MAX_QUERY_CHARS = 5_000;

/** The most memories one recall asks for. */
export const MAX_RECALL_LIMIT = 20;

const DEFAULT_RECALL_LIMIT = 5;

export interface MnemoverseConnectionConfig {
  apiKey: string;
}

export interface MnemoverseItem {
  atomId: string;
  content: string;
  relevance: number;
  domain: string;
}

export type MnemoverseResponse<T = void> = { ok: true; value: T } | { ok: false; error: string };

/** A write also says when the novelty check refused it, which a shared save treats differently. */
export type MnemoverseWriteResponse =
  | MnemoverseResponse
  | { ok: false; error: string; duplicate: true };

type Reply = { ok: true; data: unknown } | { ok: false; status?: number; error: string };

function failure(action: string, error: unknown): string {
  return `Mnemoverse ${action} failed: ${error instanceof Error ? error.message : String(error)}`;
}

/** One request. Every failure, returned or thrown, comes back as a value. */
async function request(
  config: MnemoverseConnectionConfig,
  action: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  options: { body?: unknown; signal?: AbortSignal } = {},
): Promise<Reply> {
  try {
    const signal = deadlineSignal(MNEMOVERSE_TIMEOUT_MS, options.signal);
    const response = await fetch(`${MNEMOVERSE_BASE_URL}${path}`, {
      method,
      headers: {
        "X-Api-Key": config.apiKey,
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      await bestEffort("cancel unread response body", response.body?.cancel());
      return {
        ok: false,
        status: response.status,
        error: `Mnemoverse ${action} failed: ${response.status}`,
      };
    }
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > MAX_MNEMOVERSE_RESPONSE_BYTES) {
      await bestEffort("cancel unread response body", response.body?.cancel());
      throw new ResponseTooLargeError("Mnemoverse response is too large.");
    }
    const bytes = await readBodyCapped(response, MAX_MNEMOVERSE_RESPONSE_BYTES, signal);
    // A success with no body carries nothing to read. A read or write then fails below, because
    // its required field is missing; a delete only needs the status.
    const text = new TextDecoder().decode(bytes);
    return { ok: true, data: text.trim() ? JSON.parse(text) : null };
  } catch (error) {
    return { ok: false, error: failure(action, error) };
  }
}

function boundedLimit(limit: number): number {
  return Number.isFinite(limit)
    ? Math.min(Math.max(1, Math.floor(limit)), MAX_RECALL_LIMIT)
    : DEFAULT_RECALL_LIMIT;
}

/** Null when the reply has no `items` list: that is not an answer, so it must not read as no matches. */
function parseItems(data: unknown): MnemoverseItem[] | null {
  const items = (data as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return null;
  const parsed: MnemoverseItem[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    // A replaced revision is history. Which ones a read returns depends on an account setting.
    if (row.superseded_by) continue;
    if (typeof row.atom_id !== "string" || typeof row.domain !== "string") continue;
    const content = typeof row.content === "string" ? row.content.trim() : "";
    if (!content) continue;
    parsed.push({
      atomId: row.atom_id,
      content: content.slice(0, MAX_MEMORY_CONTENT_CHARS),
      relevance: typeof row.relevance === "number" ? row.relevance : 0,
      domain: row.domain,
    });
  }
  return parsed;
}

/** Checks the key with a read that changes nothing. */
export async function probeMnemoverse(
  config: MnemoverseConnectionConfig,
  signal?: AbortSignal,
): Promise<MnemoverseResponse> {
  const reply = await request(config, "connection check", "GET", "/memory/stats", { signal });
  if (reply.ok) return { ok: true, value: undefined };
  return {
    ok: false,
    error:
      reply.status === 401 || reply.status === 403
        ? `Mnemoverse rejected the API key: ${reply.status}`
        : reply.error,
  };
}

export async function readMnemoverse(
  config: MnemoverseConnectionConfig,
  query: string,
  domain: string,
  limit: number,
  signal?: AbortSignal,
): Promise<MnemoverseResponse<MnemoverseItem[]>> {
  const reply = await request(config, "recall", "POST", "/memory/read", {
    body: { query: query.slice(0, MAX_QUERY_CHARS), domain, top_k: boundedLimit(limit) },
    signal,
  });
  if (!reply.ok) return { ok: false, error: reply.error };
  const items = parseItems(reply.data);
  return items
    ? { ok: true, value: items }
    : { ok: false, error: "Mnemoverse recall failed: unexpected response." };
}

/**
 * A write the novelty check refuses answers 200 with `stored: false`: nothing was written, and
 * the text is too close to a memory already in that domain. That is reported, not counted as saved.
 */
export async function writeMnemoverse(
  config: MnemoverseConnectionConfig,
  content: string,
  domain: string,
  signal?: AbortSignal,
): Promise<MnemoverseWriteResponse> {
  const memory = content.trim();
  if (!memory) return { ok: false, error: "Mnemoverse save skipped: memory content is empty." };
  if (memory.length > MAX_MEMORY_CONTENT_CHARS) {
    return {
      ok: false,
      error: `Mnemoverse save skipped: memory content is longer than ${MAX_MEMORY_CONTENT_CHARS} characters. Save a shorter fact.`,
    };
  }
  const reply = await request(config, "save", "POST", "/memory/write", {
    body: { content: memory, domain },
    signal,
  });
  if (!reply.ok) return { ok: false, error: reply.error };
  const written = reply.data as { stored?: unknown; reason?: unknown } | null;
  if (written?.stored === false) {
    const reason =
      typeof written.reason === "string" && written.reason ? `: ${written.reason}` : "";
    return {
      ok: false,
      duplicate: true,
      error: `Mnemoverse did not store this memory because it is too close to one already saved${reason}. Forget the older memory first if this one replaces it.`,
    };
  }
  // Only an explicit confirmation counts as saved.
  if (written?.stored !== true) {
    return { ok: false, error: "Mnemoverse save failed: unexpected response." };
  }
  return { ok: true, value: undefined };
}

/** The domain an atom lives in, or null when no such atom is reachable with this key. */
export async function getMnemoverseAtomDomain(
  config: MnemoverseConnectionConfig,
  atomId: string,
  signal?: AbortSignal,
): Promise<MnemoverseResponse<string | null>> {
  const reply = await request(
    config,
    "lookup",
    "GET",
    `/memory/atoms/${encodeURIComponent(atomId)}`,
    { signal },
  );
  if (!reply.ok) {
    return reply.status === 404 ? { ok: true, value: null } : { ok: false, error: reply.error };
  }
  const domain = (reply.data as { domain?: unknown } | null)?.domain;
  return { ok: true, value: typeof domain === "string" ? domain : null };
}

/** An atom that is already gone counts as deleted, so a retry or a race is safe. */
export async function deleteMnemoverseAtom(
  config: MnemoverseConnectionConfig,
  atomId: string,
  signal?: AbortSignal,
): Promise<MnemoverseResponse> {
  const reply = await request(
    config,
    "delete",
    "DELETE",
    `/memory/atoms/${encodeURIComponent(atomId)}`,
    { signal },
  );
  if (reply.ok || reply.status === 404) return { ok: true, value: undefined };
  return { ok: false, error: reply.error };
}
