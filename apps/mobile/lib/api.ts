import type {
  Bot,
  BotSection,
  ComputerMode,
  Group,
  Me,
  MessageBlock,
  ModelCatalogEntry,
  ModelCredential,
  Space,
  SpaceNavigation,
} from "@rakazo/contracts";
import {
  isRunTerminalEvent,
  mergeThreadHistory,
  prependThreadHistoryPage,
  progressMessageId,
  reduceLiveMessageBlocks,
  runFailureError,
  type ThreadHistory,
  upsertMessageById,
} from "@rakazo/core";
import * as SecureStore from "expo-secure-store";
import { defaultApiBase, type EndpointResult, normalizeApiBase } from "./endpoint";
import { t } from "./i18n";
import { resumeLiveNotifications } from "./live-notifications";
import {
  clearSessionToken,
  loadSessionToken,
  restoreSessionToken,
  saveSessionToken,
  snapshotSessionToken,
  tokenFromAuthResponse,
} from "./session";

const ENDPOINT_KEY = "rakazo.api_base";
const SPACE_KEY = "rakazo.space_id";
const SPACE_ROLLBACK_KEY = "rakazo.space_rollback";
const RPC_TIMEOUT_MS = 8_000;

let cachedApiBase: string | undefined;
let cachedSpaceId = "";

function responseErrorMessage(body: unknown, fallback: string): string {
  return typeof body === "object" && body && "message" in body
    ? String((body as { message?: string }).message ?? fallback)
    : fallback;
}

export function currentApiBase() {
  const parsed = normalizeApiBase(cachedApiBase ?? defaultApiBase());
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.url;
}

export async function loadApiBase() {
  let apiBase = defaultApiBase();
  try {
    const stored = await SecureStore.getItemAsync(ENDPOINT_KEY);
    if (stored) {
      const parsed = normalizeApiBase(stored);
      if (parsed.ok) {
        apiBase = parsed.url;
      }
    }
  } catch {
    // SecureStore is unavailable in some test / web hosts.
  }
  cachedApiBase = apiBase;
  try {
    const storedSpace = (await SecureStore.getItemAsync(SPACE_KEY)) ?? "";
    cachedSpaceId = storedSpace;
    if (!storedSpace) await recoverSpaceRollback(cachedApiBase);
  } catch {
    // Keep any in-memory selection when SecureStore is temporarily unavailable.
  }
  return cachedApiBase;
}

export async function selectSpace(id: string) {
  if (!(await clearStoredValue(SPACE_ROLLBACK_KEY))) return false;
  try {
    await SecureStore.setItemAsync(SPACE_KEY, id);
    cachedSpaceId = id;
    await resumeLiveNotifications(currentApiBase(), await loadSessionToken(), id).catch(
      () => undefined,
    );
    return true;
  } catch {
    return false;
  }
}

export function selectedSpaceId(): string | null {
  return cachedSpaceId || null;
}

export async function selectInitialSpace(id: string) {
  if (selectedSpaceId()) return true;
  return selectSpace(id);
}

async function clearSpace(): Promise<boolean> {
  const spaceCleared = await clearStoredValue(SPACE_KEY);
  const rollbackCleared = await clearStoredValue(SPACE_ROLLBACK_KEY);
  if (!spaceCleared || !rollbackCleared) return false;
  cachedSpaceId = "";
  return true;
}

async function clearStoredValue(key: string): Promise<boolean> {
  try {
    await SecureStore.deleteItemAsync(key);
    return true;
  } catch {
    try {
      await SecureStore.setItemAsync(key, "");
      return true;
    } catch {
      return false;
    }
  }
}

async function snapshotSpace(): Promise<{ ok: true; value: string } | { ok: false }> {
  if (cachedSpaceId) return { ok: true, value: cachedSpaceId };
  try {
    return { ok: true, value: (await SecureStore.getItemAsync(SPACE_KEY)) ?? "" };
  } catch {
    return { ok: false };
  }
}

/** Clears session + space for an endpoint change. Restores both if either wipe fails. */
async function clearCredentialsForEndpointChange(): Promise<
  { ok: true; previousToken: string; previousSpace: string } | { ok: false; result: EndpointResult }
> {
  const previousToken = await snapshotSessionToken();
  const previousSpace = await snapshotSpace();
  if (!previousToken.ok || !previousSpace.ok) {
    return {
      ok: false,
      result: { ok: false, error: t("Could not clear the previous server session") },
    };
  }
  const rollbackReady = previousSpace.value
    ? await saveSpaceRollback(previousSpace.value)
    : await clearStoredValue(SPACE_ROLLBACK_KEY);
  if (!rollbackReady) {
    return {
      ok: false,
      result: { ok: false, error: t("Could not clear the previous server session") },
    };
  }
  const sessionCleared = await clearSessionToken();
  cachedSpaceId = "";
  const spaceCleared = await clearStoredValue(SPACE_KEY);
  if (sessionCleared && spaceCleared) {
    return { ok: true, previousToken: previousToken.value, previousSpace: previousSpace.value };
  }

  await restoreCredentials(previousToken.value, previousSpace.value);
  return {
    ok: false,
    result: { ok: false, error: t("Could not clear the previous server session") },
  };
}

async function restoreCredentials(previousToken: string, previousSpace: string) {
  if (previousToken) await restoreSessionToken(previousToken);
  if (previousSpace) {
    cachedSpaceId = previousSpace;
    try {
      await SecureStore.setItemAsync(SPACE_KEY, previousSpace);
      await clearStoredValue(SPACE_ROLLBACK_KEY);
    } catch {
      // The endpoint-bound rollback record restores this selection after restart.
    }
  }
  if (previousToken) {
    await resumeLiveNotifications(currentApiBase(), previousToken, previousSpace).catch(
      () => undefined,
    );
  }
}

async function saveSpaceRollback(spaceId: string): Promise<boolean> {
  try {
    await SecureStore.setItemAsync(
      SPACE_ROLLBACK_KEY,
      JSON.stringify({ apiBase: currentApiBase(), spaceId }),
    );
    return true;
  } catch {
    return false;
  }
}

async function recoverSpaceRollback(apiBase: string) {
  const stored = await SecureStore.getItemAsync(SPACE_ROLLBACK_KEY);
  if (!stored) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    await clearStoredValue(SPACE_ROLLBACK_KEY);
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    await clearStoredValue(SPACE_ROLLBACK_KEY);
    return;
  }
  const rollback = parsed as { apiBase?: unknown; spaceId?: unknown };
  if (rollback.apiBase !== apiBase || typeof rollback.spaceId !== "string" || !rollback.spaceId) {
    await clearStoredValue(SPACE_ROLLBACK_KEY);
    return;
  }
  try {
    cachedSpaceId = rollback.spaceId;
    await SecureStore.setItemAsync(SPACE_KEY, rollback.spaceId);
    await clearStoredValue(SPACE_ROLLBACK_KEY);
  } catch {
    // Keep a valid recovery record for the next launch when storage is writable.
  }
}

export async function saveApiBase(input: string): Promise<EndpointResult> {
  const parsed = normalizeApiBase(input);
  if (!parsed.ok) return parsed;
  if (parsed.url === defaultApiBase()) return resetApiBase();
  const previous = currentApiBase();
  let cleared: { previousToken: string; previousSpace: string } | undefined;
  if (parsed.url !== previous) {
    const result = await clearCredentialsForEndpointChange();
    if (!result.ok) return result.result;
    cleared = result;
  }
  try {
    await SecureStore.setItemAsync(ENDPOINT_KEY, parsed.url);
  } catch {
    if (cleared) await restoreCredentials(cleared.previousToken, cleared.previousSpace);
    return { ok: false, error: t("Could not save the server URL") };
  }
  cachedApiBase = parsed.url;
  await clearStoredValue(SPACE_ROLLBACK_KEY);
  return parsed;
}

export async function resetApiBase(): Promise<EndpointResult> {
  const previous = currentApiBase();
  const url = defaultApiBase();
  let cleared: { previousToken: string; previousSpace: string } | undefined;
  if (url !== previous) {
    const result = await clearCredentialsForEndpointChange();
    if (!result.ok) return result.result;
    cleared = result;
  }
  try {
    await SecureStore.deleteItemAsync(ENDPOINT_KEY);
  } catch {
    if (cleared) {
      await restoreCredentials(cleared.previousToken, cleared.previousSpace);
      return { ok: false, error: t("Could not clear the custom server URL") };
    }
  }
  cachedApiBase = url;
  await clearStoredValue(SPACE_ROLLBACK_KEY);
  return { ok: true, url };
}

export async function authHeaders(
  spaceId: string | null = selectedSpaceId(),
): Promise<Record<string, string>> {
  const token = await loadSessionToken();
  return {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
  };
}

export type ApiRequestContext = {
  apiBase: string;
  headers: Record<string, string>;
};

export async function captureApiRequestContext(): Promise<ApiRequestContext> {
  const apiBase = currentApiBase();
  const headers = await authHeaders(selectedSpaceId());
  if (apiBase !== currentApiBase()) {
    throw new Error(t("The server changed while starting the request"));
  }
  return { apiBase, headers };
}

async function authenticateWithEmail(
  action: "sign-in" | "sign-up",
  input: { email: string; password: string; name?: string },
) {
  const res = await fetch(`${currentApiBase()}/api/auth/${action}/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "rakazo://" },
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(responseErrorMessage(body, `Could not ${action.replace("-", " ")}`));
  }
  const token = tokenFromAuthResponse(res, body);
  if (!token)
    throw new Error(
      t(
        action === "sign-in"
          ? "Sign-in did not return a session"
          : "Sign-up did not return a session",
      ),
    );
  if (!(await clearSpace())) throw new Error(t("Could not clear the previous space"));
  await saveSessionToken(token);
}

export function signIn(email: string, password: string) {
  return authenticateWithEmail("sign-in", { email, password });
}

export function signUp(email: string, password: string, name: string) {
  return authenticateWithEmail("sign-up", { email, password, name });
}

export type PasswordResetCapabilities = { passwordReset: boolean; resetUrl: string | null };

export async function passwordResetCapabilities(): Promise<PasswordResetCapabilities> {
  const response = await fetch(`${currentApiBase()}/api/auth/capabilities`, {
    headers: { origin: "rakazo://" },
  });
  if (!response.ok) throw new Error("Could not load password recovery settings");
  return (await response.json()) as PasswordResetCapabilities;
}

export async function requestPasswordReset(email: string, redirectTo: string): Promise<void> {
  const response = await fetch(`${currentApiBase()}/api/auth/request-password-reset`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "rakazo://" },
    body: JSON.stringify({ email, redirectTo }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(responseErrorMessage(body, t("Could not send reset email")));
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  const response = await fetch(`${currentApiBase()}/api/auth/change-password`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "rakazo://", ...(await authHeaders()) },
    body: JSON.stringify({ currentPassword, newPassword, revokeOtherSessions: true }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(responseErrorMessage(body, t("Could not change password")));
}

export async function signOut() {
  await rpc("notifications/unregisterPush").catch(() => undefined);
  const headers = await authHeaders();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    await withAbort(
      fetch(`${currentApiBase()}/api/auth/sign-out`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "rakazo://", ...headers },
        signal: controller.signal,
      }),
      controller.signal,
    ).catch(() => undefined);
  } finally {
    clearTimeout(timer);
  }
  const sessionCleared = await clearSessionToken();
  const spaceCleared = await clearSpace();
  if (!sessionCleared || !spaceCleared) throw new Error(t("Could not clear the local session"));
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Request timed out"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("Request timed out"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export async function deleteAccount(password: string) {
  await rpc("notifications/unregisterPush").catch(() => undefined);
  const res = await fetch(`${currentApiBase()}/api/auth/delete-user`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "rakazo://", ...(await authHeaders()) },
    body: JSON.stringify({ password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(responseErrorMessage(body, t("Could not delete account")));
  }
  await clearSessionToken();
  await clearSpace();
}

export async function rpc<T>(
  proc: string,
  body: unknown = {},
  options: {
    signal?: AbortSignal;
    timeoutMs?: number | null;
    requestContext?: ApiRequestContext;
  } = {},
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  const timer =
    options.timeoutMs === null ? undefined : setTimeout(abort, options.timeoutMs ?? RPC_TIMEOUT_MS);
  try {
    const res = await fetch(`${options.requestContext?.apiBase ?? currentApiBase()}/rpc/${proc}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "rakazo://",
        ...(options.requestContext?.headers ?? (await authHeaders())),
      },
      body: JSON.stringify({ json: body }),
      signal: controller.signal,
    });
    const parsed = (await res.json()) as { json?: T; error?: { message?: string } };
    if (!res.ok || parsed.error) throw new Error(parsed.error?.message ?? `rpc ${proc} failed`);
    return parsed.json as T;
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

export type MobileBot = Pick<
  Bot,
  | "id"
  | "name"
  | "preview"
  | "title"
  | "color"
  | "notifyOnFinish"
  | "threadId"
  | "pinned"
  | "status"
  | "sectionId"
  | "archivedAt"
  | "unread"
  | "updatedAt"
  | "computerMode"
> &
  Partial<Pick<Bot, "parentBotId" | "spaceId">>;

export type MobileBotSection = BotSection;

export type MobileMe = Pick<
  Me,
  "name" | "email" | "spaceId" | "defaultProvider" | "defaultModel" | "needsModel" | "avatarStyle"
>;

export type MobileModel = ModelCatalogEntry;

export type MobileModelCredential = ModelCredential;

export type MobileMessage = {
  id: string;
  threadId?: string;
  seq?: number;
  runId?: string;
  role: "user" | "bot" | "system";
  botId?: string;
  replyToMessageId?: string;
  thumbsUp?: boolean;
  blocks: MessageBlock[];
};

export type MobileGroup = Pick<
  Group,
  | "id"
  | "name"
  | "preview"
  | "pinned"
  | "sectionId"
  | "archivedAt"
  | "unread"
  | "updatedAt"
  | "members"
> &
  Partial<Pick<Group, "spaceId">>;

export type MobileSpace = Space;
export type MobileSpaceNavigation = SpaceNavigation;

export type MobileSnapshot = {
  botId?: string;
  groupId?: string;
  groupName?: string;
  threadId: string;
  cursor?: number;
  messages: MobileMessage[];
  olderCursor: number | null;
  run: { id: string; botId?: string; status: string; error?: string | null } | null;
  activeRuns?: Array<{ id: string; botId?: string; status: string }>;
  members?: MobileGroup["members"];
  computer?: {
    state: string;
    controlHolder: string;
    screenAvailable: boolean;
    mode: ComputerMode;
    busyBotName: string | null;
  };
};

export function shouldApplyMobileThreadRefresh(input: {
  requestEpoch: number;
  currentEpoch: number;
  targetBotId: string | undefined;
  targetGroupId: string | undefined;
  activeBotId: string | undefined;
  activeGroupId: string | undefined;
}) {
  return (
    input.requestEpoch === input.currentEpoch &&
    input.targetBotId === input.activeBotId &&
    input.targetGroupId === input.activeGroupId
  );
}

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

const MESSAGING_PROVIDER_LABELS: Record<string, string> = {
  sendblue: "iMessage",
  slack: "Slack",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
};

export function messagingProviderLabel(provider: string): string {
  return MESSAGING_PROVIDER_LABELS[provider] ?? provider;
}

export function blockText(message: MobileMessage) {
  return message.blocks
    .map((block) => {
      if (block.kind === "channel_message") {
        return `${messagingProviderLabel(block.provider)} · ${block.fromLabel}: ${block.text}`;
      }
      if (block.kind === "subagent") {
        return `${block.name ?? "subagent"}: ${block.result || block.progress || block.task || ""}`;
      }
      if (block.kind === "child_bot") {
        return `${block.status === "archived" ? "Archived" : block.status === "deleted" ? "Deleted" : "Bot"} ${block.name ?? ""}`;
      }
      if (block.kind === "chart") return `[chart: ${block.name ?? "chart"}]`;
      if (block.kind === "image") return `[image: ${block.name ?? "attachment"}]`;
      if (block.kind === "file") {
        return `[file: ${block.name ?? "attachment"}${block.size ? ` (${block.size} bytes)` : ""}]`;
      }
      if (block.kind === "steps") {
        return (block.steps ?? [])
          .map((step) => `${step.label}${step.count > 1 ? ` ×${step.count}` : ""}`)
          .join(" · ");
      }
      return ("text" in block ? block.text : "state" in block ? block.state : "") ?? "";
    })
    .filter(Boolean)
    .join("\n");
}

type ThreadEvent = {
  id?: string;
  botId?: string;
  type: string;
  seq?: number;
  runId?: string;
  payload?: Record<string, unknown>;
};

function takeMobileLiveMessage(
  snapshot: MobileSnapshot,
  liveId: string,
): { previous: MobileMessage | undefined; remaining: MobileMessage[] } {
  let previous: MobileMessage | undefined;
  const remaining: MobileMessage[] = [];
  for (const message of snapshot.messages) {
    if (message.id === liveId) {
      previous = message;
    } else if (!message.id.startsWith("progress:") || message.runId) {
      remaining.push(message);
    }
  }
  return { previous, remaining };
}

export async function subscribeThread(
  target: { botId: string } | { groupId: string },
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
    body: JSON.stringify({ json: { ...target, cursor } }),
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
    return {
      ...prev,
      cursor: event.seq,
      messages: [],
      olderCursor: null,
      run: null,
      activeRuns: [],
    };
  }
  if (event.type === "run.waiting_input") {
    const progressId = progressMessageId(event);
    const messages = prev.messages.filter((message) => message.id !== progressId);
    const progressCleared = messages.length !== prev.messages.length;
    const runChanged = Boolean(
      prev.run && prev.run.id === event.runId && prev.run.status !== "waiting_input",
    );
    const activeRunChanged = prev.activeRuns?.some(
      (candidate) => candidate.id === event.runId && candidate.status !== "waiting_input",
    );
    const cursor = event.seq ?? prev.cursor;
    if (!runChanged && !activeRunChanged && !progressCleared) {
      return cursor === prev.cursor ? prev : { ...prev, cursor };
    }
    const run = runChanged && prev.run ? { ...prev.run, status: "waiting_input" } : prev.run;
    const activeRuns = activeRunChanged
      ? prev.activeRuns?.map((candidate) =>
          candidate.id === event.runId ? { ...candidate, status: "waiting_input" } : candidate,
        )
      : prev.activeRuns;
    return { ...prev, cursor, run, activeRuns, messages };
  }
  if (isRunTerminalEvent(event)) {
    const activeRuns = prev.activeRuns?.filter((candidate) => candidate.id !== event.runId);
    const failure = runFailureError(event);
    const primaryEnded = prev.run?.id === event.runId ? prev.run : null;
    // A group member run can fail while another is displayed; see reduceThreadSnapshot.
    const endedRun =
      primaryEnded ?? prev.activeRuns?.find((candidate) => candidate.id === event.runId) ?? null;
    return {
      ...prev,
      cursor: event.seq ?? prev.cursor,
      messages: prev.messages.filter((message) => message.id !== progressMessageId(event)),
      // A failed run stays in run so the thread can say why it stopped (see reduceThreadSnapshot).
      run:
        endedRun && failure
          ? { ...endedRun, status: "failed", error: failure }
          : primaryEnded
            ? (activeRuns?.[0] ?? null)
            : prev.run,
      activeRuns,
    };
  }
  if (event.type === "thread.progress") {
    const progressId = progressMessageId(event);
    const { previous, remaining } = takeMobileLiveMessage(prev, progressId);
    const streaming: MobileMessage = {
      id: progressId,
      role: "bot",
      blocks: reduceLiveMessageBlocks((previous?.blocks ?? []) as MessageBlock[], {
        type: "progress",
        payload: event.payload,
      }),
      ...(event.botId ? { botId: event.botId } : {}),
      ...(event.runId ? { runId: event.runId } : {}),
    };
    return {
      ...prev,
      cursor: event.seq ?? prev.cursor,
      messages: [...remaining, streaming],
    };
  }
  if (event.type === "agent.tool.called") {
    const progressId = progressMessageId(event);
    const { previous, remaining } = takeMobileLiveMessage(prev, progressId);
    const streaming: MobileMessage = {
      id: progressId,
      role: "bot",
      blocks: reduceLiveMessageBlocks((previous?.blocks ?? []) as MessageBlock[], {
        type: "tool",
        name: String(event.payload?.name ?? ""),
      }),
      ...(event.botId ? { botId: event.botId } : {}),
      ...(event.runId ? { runId: event.runId } : {}),
    };
    return {
      ...prev,
      cursor: event.seq ?? prev.cursor,
      messages: [...remaining, streaming],
    };
  }
  if (event.type === "thread.subagent") {
    const agentId = String(event.payload?.agentId ?? event.id ?? "live");
    const status = event.payload?.status;
    const streaming: MobileMessage = {
      id: `subagent:${agentId}`,
      role: "bot",
      ...(event.botId ? { botId: event.botId } : {}),
      ...(event.runId ? { runId: event.runId } : {}),
      blocks: [
        {
          kind: "subagent",
          agentId,
          name: String(event.payload?.name ?? "subagent"),
          task: String(event.payload?.task ?? ""),
          status: status === "completed" || status === "failed" ? status : "running",
          progress: event.payload?.progress ? String(event.payload.progress) : undefined,
          result: event.payload?.result ? String(event.payload.result) : undefined,
        },
      ],
    };
    return {
      ...prev,
      cursor: event.seq ?? prev.cursor,
      messages: [...prev.messages.filter((message) => message.id !== streaming.id), streaming],
    };
  }
  if (event.type === "thread.message.reaction") {
    const messageId = String(event.payload?.messageId ?? "");
    return {
      ...prev,
      cursor: event.seq ?? prev.cursor,
      messages: prev.messages.map((message) =>
        message.id === messageId
          ? { ...message, thumbsUp: event.payload?.thumbsUp === true }
          : message,
      ),
    };
  }
  if (event.type === "thread.message.created" || event.type === "thread.message.updated") {
    const { remaining } = takeMobileLiveMessage(prev, progressMessageId(event));
    const next: MobileMessage = {
      id: String(event.payload?.messageId ?? event.id ?? `msg:${event.seq ?? 0}`),
      runId: event.runId ? String(event.runId) : undefined,
      role: (event.payload?.role as MobileMessage["role"]) ?? "bot",
      blocks: (event.payload?.blocks as MobileMessage["blocks"]) ?? [],
      botId: event.botId ?? (event.payload?.botId ? String(event.payload.botId) : undefined),
      replyToMessageId: event.payload?.replyToMessageId
        ? String(event.payload.replyToMessageId)
        : undefined,
      thumbsUp: event.payload?.thumbsUp === true,
    };
    return {
      ...prev,
      cursor: event.seq ?? prev.cursor,
      messages: upsertMessageById(
        remaining.filter(
          (message) =>
            !(
              message.id.startsWith("subagent:") &&
              next.blocks.some(
                (block) => block.kind === "subagent" && message.id === `subagent:${block.agentId}`,
              )
            ),
        ),
        next,
      ),
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
