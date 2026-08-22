import type {
  Bot,
  BotSection,
  ComputerMode,
  Me,
  ModelCatalogEntry,
  ModelCredential,
} from "@rakazo/contracts";
import {
  mergeThreadHistory,
  prependThreadHistoryPage,
  progressMessageId,
  progressMessageText,
  type ThreadHistory,
} from "@rakazo/core";
import * as SecureStore from "expo-secure-store";
import { defaultApiBase, type EndpointResult, normalizeApiBase } from "./endpoint";
import {
  clearSessionToken,
  loadSessionToken,
  saveSessionToken,
  tokenFromAuthResponse,
} from "./session";

const ENDPOINT_KEY = "rakazo.api_base";

let cachedApiBase: string | undefined;

function responseErrorMessage(body: unknown, fallback: string): string {
  return typeof body === "object" && body && "message" in body
    ? String((body as { message?: string }).message ?? fallback)
    : fallback;
}

export function currentApiBase() {
  return cachedApiBase ?? defaultApiBase();
}

export async function loadApiBase() {
  try {
    const stored = await SecureStore.getItemAsync(ENDPOINT_KEY);
    if (stored) {
      const parsed = normalizeApiBase(stored);
      if (parsed.ok) {
        cachedApiBase = parsed.url;
        return cachedApiBase;
      }
    }
  } catch {
    // SecureStore is unavailable in some test / web hosts.
  }
  cachedApiBase = defaultApiBase();
  return cachedApiBase;
}

export async function saveApiBase(input: string): Promise<EndpointResult> {
  const parsed = normalizeApiBase(input);
  if (!parsed.ok) return parsed;
  if (parsed.url === defaultApiBase()) return resetApiBase();
  const previous = currentApiBase();
  await SecureStore.setItemAsync(ENDPOINT_KEY, parsed.url);
  cachedApiBase = parsed.url;
  if (parsed.url !== previous) await clearSessionToken();
  return parsed;
}

export async function resetApiBase(): Promise<EndpointResult> {
  const previous = currentApiBase();
  try {
    await SecureStore.deleteItemAsync(ENDPOINT_KEY);
  } catch {
    // ignore missing keys
  }
  const url = defaultApiBase();
  cachedApiBase = url;
  if (url !== previous) await clearSessionToken();
  return { ok: true, url };
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await loadSessionToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

export async function signIn(email: string, password: string) {
  const res = await fetch(`${currentApiBase()}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "rakazo://" },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(responseErrorMessage(body, "Could not sign in"));
  }
  const token = tokenFromAuthResponse(res, body);
  if (!token) throw new Error("Sign-in did not return a session");
  await saveSessionToken(token);
}

export async function signOut() {
  const headers = await authHeaders();
  await fetch(`${currentApiBase()}/api/auth/sign-out`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "rakazo://", ...headers },
  }).catch(() => undefined);
  await clearSessionToken();
}

export async function deleteAccount(password: string) {
  const res = await fetch(`${currentApiBase()}/api/auth/delete-user`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "rakazo://", ...(await authHeaders()) },
    body: JSON.stringify({ password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(responseErrorMessage(body, "Could not delete account"));
  }
  await clearSessionToken();
}

export async function rpc<T>(
  proc: string,
  body: unknown = {},
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  const res = await fetch(`${currentApiBase()}/rpc/${proc}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "rakazo://",
      ...(await authHeaders()),
    },
    body: JSON.stringify({ json: body }),
    signal: options.signal,
  });
  const parsed = (await res.json()) as { json?: T; error?: { message?: string } };
  if (!res.ok || parsed.error) throw new Error(parsed.error?.message ?? `rpc ${proc} failed`);
  return parsed.json as T;
}

export type MobileBot = Pick<
  Bot,
  | "id"
  | "name"
  | "preview"
  | "title"
  | "color"
  | "pinned"
  | "sectionId"
  | "archivedAt"
  | "unread"
  | "updatedAt"
  | "computerMode"
> &
  Partial<Pick<Bot, "parentBotId">>;

export type MobileBotSection = BotSection;

export type MobileMe = Pick<
  Me,
  "name" | "email" | "workspaceId" | "defaultProvider" | "defaultModel" | "needsModel"
>;

export type MobileModel = ModelCatalogEntry;

export type MobileModelCredential = ModelCredential;

export type MobileMessage = {
  id: string;
  threadId?: string;
  seq?: number;
  role: "user" | "bot" | "system";
  blocks: Array<{
    kind: string;
    text?: string;
    state?: string;
    name?: string;
    task?: string;
    status?: string;
    progress?: string;
    result?: string;
    answer?: string;
    botId?: string;
    title?: string;
    agentId?: string;
    artifactId?: string;
    mimeType?: string;
    size?: number;
  }>;
};

export type MobileSnapshot = {
  botId: string;
  threadId: string;
  cursor?: number;
  messages: MobileMessage[];
  olderCursor: number | null;
  run: { status: string } | null;
  computer: {
    state: string;
    controlHolder: string;
    screenAvailable: boolean;
    mode: ComputerMode;
    busyBotName: string | null;
  };
};

export type MobileMessagePage = ThreadHistory<MobileMessage>;

export function mergeMobileSnapshot(
  prev: MobileSnapshot | null,
  next: MobileSnapshot,
  preserveLoadedHistory = false,
): MobileSnapshot {
  return mergeThreadHistory(prev, next, preserveLoadedHistory);
}

export function prependMobileMessagePage(
  prev: MobileSnapshot | null,
  page: MobileMessagePage,
): MobileSnapshot | null {
  return prependThreadHistoryPage(prev, page);
}

export function blockText(message: MobileMessage) {
  return message.blocks
    .map((block) => {
      if (block.kind === "subagent") {
        return `${block.name ?? "subagent"}: ${block.result || block.progress || block.task || ""}`;
      }
      if (block.kind === "child_bot") {
        return `${block.status === "archived" ? "Archived" : block.status === "deleted" ? "Deleted" : "Bot"} ${block.name ?? ""}`;
      }
      if (block.kind === "image") return `[image: ${block.name ?? "attachment"}]`;
      if (block.kind === "file") {
        return `[file: ${block.name ?? "attachment"}${block.size ? ` (${block.size} bytes)` : ""}]`;
      }
      return block.text ?? block.state ?? "";
    })
    .filter(Boolean)
    .join("\n");
}

type ThreadEvent = {
  id?: string;
  type: string;
  seq?: number;
  runId?: string;
  payload?: Record<string, unknown>;
};

export async function subscribeThread(
  botId: string,
  cursor: number,
  onEvent: (event: ThreadEvent) => void,
  signal: AbortSignal,
) {
  const res = await fetch(`${currentApiBase()}/rpc/threads/subscribe`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      origin: "rakazo://",
      ...(await authHeaders()),
    },
    body: JSON.stringify({ json: { botId, cursor } }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`rpc threads/subscribe failed (${res.status})`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!signal.aborted) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const data = chunk
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
      if (!data || data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data) as { json?: ThreadEvent; error?: { message?: string } };
        if (parsed.json?.type) onEvent(parsed.json);
      } catch {
        // ignore keepalives and partial frames
      }
    }
  }
}

export function applyMobileThreadEvent(
  prev: MobileSnapshot | null,
  event: ThreadEvent,
): MobileSnapshot | null {
  if (!prev) return prev;
  if (event.type === "thread.cleared") {
    return { ...prev, cursor: event.seq, messages: [], olderCursor: null, run: null };
  }
  if (event.type === "run.waiting_input") {
    if (!prev.run || prev.run.status === "waiting_input") return prev;
    return { ...prev, run: { ...prev.run, status: "waiting_input" } };
  }
  if (event.type === "thread.progress") {
    const progressId = progressMessageId(event);
    const previous = prev.messages.find((message) => message.id === progressId);
    const previousText =
      previous?.blocks[0]?.kind === "progress" ? String(previous.blocks[0].text ?? "") : "";
    const text = progressMessageText(event.payload, previousText);
    const streaming: MobileMessage = {
      id: progressId,
      role: "bot",
      blocks: [{ kind: "progress", text }],
    };
    return {
      ...prev,
      messages: [
        ...prev.messages.filter((message) => !message.id.startsWith("progress:")),
        streaming,
      ],
    };
  }
  if (event.type === "thread.subagent") {
    const agentId = String(event.payload?.agentId ?? event.id ?? "live");
    const streaming: MobileMessage = {
      id: `subagent:${agentId}`,
      role: "bot",
      blocks: [
        {
          kind: "subagent",
          agentId,
          name: String(event.payload?.name ?? "subagent"),
          task: String(event.payload?.task ?? ""),
          status: String(event.payload?.status ?? "running"),
          progress: event.payload?.progress ? String(event.payload.progress) : undefined,
          result: event.payload?.result ? String(event.payload.result) : undefined,
        },
      ],
    };
    return {
      ...prev,
      messages: [
        ...prev.messages.filter(
          (message) => message.id !== streaming.id && !message.id.startsWith("progress:"),
        ),
        streaming,
      ],
    };
  }
  if (event.type === "thread.message.created" || event.type === "thread.message.updated") {
    const next: MobileMessage = {
      id: String(event.payload?.messageId ?? event.id ?? `msg:${event.seq ?? 0}`),
      role: (event.payload?.role as MobileMessage["role"]) ?? "bot",
      blocks: (event.payload?.blocks as MobileMessage["blocks"]) ?? [],
    };
    return {
      ...prev,
      messages: [
        ...prev.messages.filter(
          (message) =>
            message.id !== next.id &&
            !message.id.startsWith("progress:") &&
            !(
              message.id.startsWith("subagent:") &&
              next.blocks.some(
                (block) => block.kind === "subagent" && message.id === `subagent:${block.agentId}`,
              )
            ),
        ),
        next,
      ],
    };
  }
  return prev;
}

export {
  apiBaseWarning,
  defaultApiBase,
  displayApiHost,
  normalizeApiBase,
  probeApiBase,
  usesCustomApiBase,
} from "./endpoint";
export { loadSessionToken };
