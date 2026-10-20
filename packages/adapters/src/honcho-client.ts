import { readBodyCapped } from "./web-ssrf.js";

export const HONCHO_CLOUD_BASE_URL = "https://api.honcho.dev";

const HONCHO_TIMEOUT_MS = 15_000;
/** Peer chat runs Honcho's dialectic agent, which reasons over memory before answering. */
const HONCHO_CHAT_TIMEOUT_MS = 60_000;
const MAX_HONCHO_RESPONSE_BYTES = 1024 * 1024;

/** Honcho conclusions are capped server-side; keep saves in line with other providers. */
export const MAX_HONCHO_CONCLUSION_CHARS = 10_000;

export const HONCHO_REASONING_LEVELS = ["minimal", "low", "medium", "high", "max"] as const;
export type HonchoReasoningLevel = (typeof HONCHO_REASONING_LEVELS)[number];

export interface HonchoConnectionConfig {
  baseUrl: string;
  apiKey: string;
  reasoningLevel: HonchoReasoningLevel;
  /** Test seam. */
  fetch?: typeof globalThis.fetch;
}

export type HonchoResponse<T> = { ok: true; value: T } | { ok: false; error: string };

export interface HonchoConclusion {
  content: string;
  observerId: string;
  observedId: string;
}

/** Honcho resource ids allow letters, digits, `_` and `-` only. */
export function honchoResourceId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 512);
}

function requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function honchoRequest(
  config: HonchoConnectionConfig,
  path: string,
  body: unknown,
  options: { timeoutMs?: number; signal?: AbortSignal; readJson?: boolean } = {},
): Promise<HonchoResponse<unknown>> {
  const signal = requestSignal(options.timeoutMs ?? HONCHO_TIMEOUT_MS, options.signal);
  let response: Response;
  try {
    response = await (config.fetch ?? fetch)(`${config.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal,
    });
  } catch {
    return {
      ok: false,
      error: "Honcho is unreachable or the request timed out.",
    };
  }
  if (!response.ok || !options.readJson) {
    await response.body?.cancel().catch(() => undefined);
    return response.ok
      ? { ok: true, value: undefined }
      : { ok: false, error: `Honcho request failed: ${response.status}` };
  }
  try {
    const bytes = await readBodyCapped(response, MAX_HONCHO_RESPONSE_BYTES, signal);
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return {
      ok: false,
      error: "Honcho returned an unreadable response.",
    };
  }
}

function workspacePath(workspaceId: string): string {
  return `/v3/workspaces/${encodeURIComponent(workspaceId)}`;
}

/** Get-or-create. Also proves the key can write to the workspace. */
export async function ensureHonchoWorkspace(
  config: HonchoConnectionConfig,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<HonchoResponse<void>> {
  const result = await honchoRequest(config, "/v3/workspaces", { id: workspaceId }, { signal });
  return result.ok ? { ok: true, value: undefined } : result;
}

/** Listing workspaces needs an admin key and writes nothing. */
export async function probeHonchoAdminKey(
  config: HonchoConnectionConfig,
): Promise<HonchoResponse<void>> {
  const result = await honchoRequest(config, "/v3/workspaces/list?size=1", {});
  return result.ok ? { ok: true, value: undefined } : result;
}

/** Get-or-create the workspace and each peer. */
export async function ensureHonchoPeers(
  config: HonchoConnectionConfig,
  workspaceId: string,
  peerIds: string[],
  signal?: AbortSignal,
): Promise<HonchoResponse<void>> {
  const workspace = await ensureHonchoWorkspace(config, workspaceId, signal);
  if (!workspace.ok) return workspace;
  const results = await Promise.all(
    [...new Set(peerIds)].map((id) =>
      honchoRequest(config, `${workspacePath(workspaceId)}/peers`, { id }, { signal }),
    ),
  );
  const failure = results.find((result) => !result.ok);
  return failure && !failure.ok ? failure : { ok: true, value: undefined };
}

export async function createHonchoConclusions(
  config: HonchoConnectionConfig,
  workspaceId: string,
  conclusions: HonchoConclusion[],
  signal?: AbortSignal,
): Promise<HonchoResponse<void>> {
  const result = await honchoRequest(
    config,
    `${workspacePath(workspaceId)}/conclusions`,
    {
      conclusions: conclusions.map((conclusion) => ({
        content: conclusion.content,
        observer_id: conclusion.observerId,
        observed_id: conclusion.observedId,
      })),
    },
    { signal },
  );
  return result.ok ? { ok: true, value: undefined } : result;
}

/** Ask a peer's representation a question through Honcho's dialectic chat endpoint. */
export async function honchoPeerChat(
  config: HonchoConnectionConfig,
  workspaceId: string,
  request: { peerId: string; target?: string; query: string },
  signal?: AbortSignal,
): Promise<HonchoResponse<string>> {
  const result = await honchoRequest(
    config,
    `${workspacePath(workspaceId)}/peers/${encodeURIComponent(request.peerId)}/chat`,
    {
      query: request.query,
      reasoning_level: config.reasoningLevel,
      stream: false,
      ...(request.target ? { target: request.target } : {}),
    },
    { timeoutMs: HONCHO_CHAT_TIMEOUT_MS, signal, readJson: true },
  );
  if (!result.ok) return result;
  const content = (result.value as { content?: unknown } | null)?.content;
  if (typeof content !== "string") {
    return { ok: false, error: "Honcho returned an invalid chat response." };
  }
  return { ok: true, value: content.trim() };
}
