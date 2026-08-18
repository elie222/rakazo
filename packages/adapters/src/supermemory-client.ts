const DEFAULT_SUPERMEMORY_BASE_URL = "http://localhost:6767";
const SUPERMEMORY_TIMEOUT_MS = 15_000;

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
export function supermemoryContainerTag(botId: string): string {
  return `rakazo:${botId}`;
}

export function isSupermemoryEnabled(apiKey: string | undefined): boolean {
  return Boolean(apiKey);
}

function supermemoryConfig(): { baseUrl: string; apiKey: string } | undefined {
  const apiKey = process.env.SUPERMEMORY_API_KEY;
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
      body: JSON.stringify({ q: query, containerTags: [containerTag] }),
      signal: AbortSignal.timeout(SUPERMEMORY_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { ok: false, error: `Supermemory search failed: ${response.status}` };
    }
    const data = (await response.json()) as { results?: SupermemoryResult[] };
    return { ok: true, results: data.results ?? [] };
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
  try {
    const response = await fetch(`${config.baseUrl}/v4/memories`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ containerTag, memories: [{ content, isStatic: false }] }),
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
