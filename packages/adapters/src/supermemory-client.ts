const DEFAULT_SUPERMEMORY_BASE_URL = "https://api.supermemory.ai";
const SUPERMEMORY_TIMEOUT_MS = 15_000;

/** How many recalled memories a search asks for, and the most that are ever injected into a run. */
export const MAX_RECALLED_MEMORIES = 5;

/** Supermemory rejects memory content longer than this. */
export const MAX_MEMORY_CONTENT_CHARS = 10_000;

export interface SupermemoryResult {
  memory: string;
  similarity: number;
  updatedAt?: string;
}

export type SupermemorySearchResponse =
  | { ok: true; results: SupermemoryResult[] }
  | { ok: false; error: string };

export type SupermemorySaveResponse = { ok: true } | { ok: false; error: string };

/** Every bot gets its own container tag, mirroring the existing bot-scoped memory model. */
export function supermemoryContainerTag(botId: string, historyGeneration = 0): string {
  return historyGeneration > 0 ? `rakazo:${botId}:history:${historyGeneration}` : `rakazo:${botId}`;
}

export function isSupermemoryEnabled(apiKey: string | undefined): boolean {
  return Boolean(apiKey?.trim());
}

function supermemoryConfig(): { baseUrl: string; apiKey: string } | undefined {
  const apiKey = process.env.SUPERMEMORY_API_KEY?.trim();
  if (!apiKey) return undefined;
  const baseUrl = (process.env.SUPERMEMORY_API_URL ?? DEFAULT_SUPERMEMORY_BASE_URL).replace(
    /\/+$/,
    "",
  );
  return { baseUrl, apiKey };
}

function unreachableError(error: unknown): string {
  return `Supermemory is unreachable: ${error instanceof Error ? error.message : String(error)}`;
}

function parseSearchResults(data: unknown): SupermemoryResult[] {
  if (!data || typeof data !== "object") return [];
  const results = (data as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  const parsed: SupermemoryResult[] = [];
  for (const item of results) {
    if (!item || typeof item !== "object") continue;
    const row = item as {
      memory?: unknown;
      chunk?: unknown;
      similarity?: unknown;
      updatedAt?: unknown;
    };
    const text =
      typeof row.memory === "string" ? row.memory : typeof row.chunk === "string" ? row.chunk : "";
    const memory = text.trim();
    if (!memory) continue;
    parsed.push({
      memory,
      similarity: typeof row.similarity === "number" ? row.similarity : 0,
      ...(typeof row.updatedAt === "string" ? { updatedAt: row.updatedAt } : {}),
    });
  }
  return parsed;
}

export async function searchSupermemory(
  query: string,
  containerTag: string,
): Promise<SupermemorySearchResponse> {
  const config = supermemoryConfig();
  if (!config) {
    return { ok: false, error: "Supermemory is not configured (SUPERMEMORY_API_KEY is unset)." };
  }
  try {
    const response = await fetch(`${config.baseUrl}/v4/search`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        q: query,
        containerTag,
        searchMode: "memories",
        limit: MAX_RECALLED_MEMORIES,
      }),
      signal: AbortSignal.timeout(SUPERMEMORY_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { ok: false, error: `Supermemory search failed: ${response.status}` };
    }
    return { ok: true, results: parseSearchResults(await response.json()) };
  } catch (error) {
    return { ok: false, error: unreachableError(error) };
  }
}

/** Deletes every memory in a container, e.g. after the conversation they summarize is cleared. */
export async function deleteSupermemoryContainer(
  containerTag: string,
): Promise<SupermemorySaveResponse> {
  const config = supermemoryConfig();
  if (!config) {
    return { ok: false, error: "Supermemory is not configured (SUPERMEMORY_API_KEY is unset)." };
  }
  try {
    const response = await fetch(
      `${config.baseUrl}/v3/container-tags/${encodeURIComponent(containerTag)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${config.apiKey}` },
        signal: AbortSignal.timeout(SUPERMEMORY_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      return { ok: false, error: `Supermemory container delete failed: ${response.status}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: unreachableError(error) };
  }
}

export async function saveSupermemoryMemory(
  content: string,
  containerTag: string,
): Promise<SupermemorySaveResponse> {
  const config = supermemoryConfig();
  if (!config) {
    return { ok: false, error: "Supermemory is not configured (SUPERMEMORY_API_KEY is unset)." };
  }
  const memory = content.trim().slice(0, MAX_MEMORY_CONTENT_CHARS);
  if (!memory) {
    return { ok: false, error: "Supermemory save skipped: memory content is empty." };
  }
  try {
    const response = await fetch(`${config.baseUrl}/v4/memories`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ containerTag, memories: [{ content: memory, isStatic: false }] }),
      signal: AbortSignal.timeout(SUPERMEMORY_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { ok: false, error: `Supermemory save failed: ${response.status}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: unreachableError(error) };
  }
}
