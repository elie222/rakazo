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
  readBoundedJsonResponse,
  reduceLiveMessageBlocks,
  runFailureError,
  signupRequiresEmailVerification,
  type ThreadHistory,
  takeLiveMessage,
  updateCloudAgentMessages,
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
export const MAX_MOBILE_AUTH_RESPONSE_BYTES = 256 * 1024;
export const MAX_MOBILE_RPC_RESPONSE_BYTES = 16 * 1024 * 1024;
/** Inbox bootstrap reads safe to replay without a Space header during auth recovery. */
const SPACE_AUTH_RECOVERY_SAFE_PROCS = new Set(["spaces/list", "me"]);

let cachedApiBase: string | undefined;
let cachedSpaceId = "";
/** Bumped on every in-memory Space selection change so a delayed response
 * cannot treat a later reselection of the same Space id as its own. */
let spaceSelectionGeneration = 0;

function bumpSpaceSelectionGeneration(): void {
  spaceSelectionGeneration += 1;
}

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
    bumpSpaceSelectionGeneration();
    // A deletion fallback must override the now-invalid saved Space even when
    // the device failed to replace that value before the previous process exited.
    await recoverSpaceRollback(cachedApiBase);
  } catch {
    // Keep any in-memory selection when SecureStore is temporarily unavailable.
  }
  return cachedApiBase;
}

export async function selectSpace(id: string) {
  if (!(await clearStoredValue(SPACE_ROLLBACK_KEY))) return false;
  // Claim memory before persisting: recovery paths reconcile against the
  // in-memory selection, so a durable write must never precede its owner.
  const previousSpaceId = cachedSpaceId;
  cachedSpaceId = id;
  bumpSpaceSelectionGeneration();
  try {
    await SecureStore.setItemAsync(SPACE_KEY, id);
    // Our write may have landed stale behind a newer overlapping selection's
    // write. Re-assert the live selection best-effort so durable converges
    // to it; each selector heals at most once, so overlapping chains settle
    // on the latest claim. Never delete here: a missing memory owner means
    // another path (recovery, sign-out) owns cleanup.
    const liveSpaceId = cachedSpaceId;
    if (liveSpaceId && liveSpaceId !== id) {
      await writeStoredValue(SPACE_KEY, liveSpaceId);
    }
  } catch {
    // Roll back the claim and heal durable state: a concurrent recovery may
    // have persisted the rolled-back id after reading it, which would leave
    // restart opening a Space the live session is not using. A newer
    // overlapping selection owns both by now, so only heal a claim we hold.
    if (cachedSpaceId === id) {
      cachedSpaceId = previousSpaceId;
      bumpSpaceSelectionGeneration();
      if (previousSpaceId) await writeStoredValue(SPACE_KEY, previousSpaceId);
    }
    return false;
  }
  await resumeLiveNotifications(currentApiBase(), await loadSessionToken(), id).catch(
    () => undefined,
  );
  return true;
}

export function selectedSpaceId(): string | null {
  return cachedSpaceId || null;
}

/** Keep requests usable after the server deleted the selected Space but native
 * storage could not replace it. Neutralize any same-endpoint rollback before
 * writing the replacement selection so a cleanup failure cannot leave the new
 * id beside a stale record that recoverSpaceRollback would prefer on restart. */
export async function adoptDeletedSpaceFallback(id: string): Promise<boolean> {
  cachedSpaceId = id;
  bumpSpaceSelectionGeneration();
  // Neutralize any same-endpoint rollback before writing SPACE_KEY. Writing the
  // selection first can leave it beside a stale record that recoverSpaceRollback
  // would prefer on restart if later cleanup fails.
  const rollbackNeutralized =
    (await clearStoredValue(SPACE_ROLLBACK_KEY)) || (await saveSpaceRollback(id));
  if (rollbackNeutralized && (await writeStoredValue(SPACE_KEY, id))) {
    // SPACE_KEY is authoritative; drop a rollback we may have written only to
    // overwrite a stale record (best-effort).
    await clearStoredValue(SPACE_ROLLBACK_KEY);
    await resumeLiveNotifications(currentApiBase(), await loadSessionToken(), id).catch(
      () => undefined,
    );
    return true;
  }
  // Clear before saving recovery: an empty selection lets startup resolve the
  // server default even when the recovery record cannot be written.
  const staleSelectionCleared = await clearStoredValue(SPACE_KEY);
  const recoverySaved = await saveSpaceRollback(id);
  await resumeLiveNotifications(currentApiBase(), await loadSessionToken(), id).catch(
    () => undefined,
  );
  // Only treat a cleared selection as durable success when no same-endpoint
  // rollback remains to override it after restart.
  return recoverySaved || (staleSelectionCleared && (await clearStoredValue(SPACE_ROLLBACK_KEY)));
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
  bumpSpaceSelectionGeneration();
  return true;
}

async function clearStoredValue(key: string): Promise<boolean> {
  try {
    await SecureStore.deleteItemAsync(key);
    return true;
  } catch {
    return writeStoredValue(key, "");
  }
}

async function writeStoredValue(key: string, value: string): Promise<boolean> {
  try {
    await SecureStore.setItemAsync(key, value);
    return true;
  } catch {
    return false;
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
  bumpSpaceSelectionGeneration();
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
    bumpSpaceSelectionGeneration();
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
  return writeStoredValue(
    SPACE_ROLLBACK_KEY,
    JSON.stringify({ apiBase: currentApiBase(), spaceId }),
  );
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
  cachedSpaceId = rollback.spaceId;
  bumpSpaceSelectionGeneration();
  if (await writeStoredValue(SPACE_KEY, rollback.spaceId)) {
    await clearStoredValue(SPACE_ROLLBACK_KEY);
    return;
  }
  // Could not replace the selection yet. Drop the deleted id so startup RPCs
  // are not scoped to an inaccessible Space; keep the recovery record.
  await clearStoredValue(SPACE_KEY);
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
  const { response, body } = await fetchMobileJson<unknown>(
    `${currentApiBase()}/api/auth/${action}/email`,
    {
      method: "POST",
      headers: { "content-type": "application/json", origin: "rakazo://" },
      body: JSON.stringify(input),
    },
    {},
  );
  if (!response.ok) {
    throw new Error(responseErrorMessage(body, `Could not ${action.replace("-", " ")}`));
  }
  const token = tokenFromAuthResponse(response, body);
  if (action === "sign-up" && signupRequiresEmailVerification(body))
    return { verificationRequired: true };
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
  return { verificationRequired: false };
}

export function signIn(email: string, password: string) {
  return authenticateWithEmail("sign-in", { email, password });
}

export function signUp(email: string, password: string, name: string) {
  return authenticateWithEmail("sign-up", { email, password, name });
}

export type PasswordResetCapabilities = { passwordReset: boolean; resetUrl: string | null };

export async function passwordResetCapabilities(): Promise<PasswordResetCapabilities> {
  const { response, body } = await fetchMobileJson<PasswordResetCapabilities>(
    `${currentApiBase()}/api/auth/capabilities`,
    { headers: { origin: "rakazo://" } },
    { passwordReset: false, resetUrl: null },
  );
  if (!response.ok) throw new Error("Could not load password recovery settings");
  return body;
}

export async function requestPasswordReset(email: string, redirectTo: string): Promise<void> {
  const { response, body } = await fetchMobileJson<unknown>(
    `${currentApiBase()}/api/auth/request-password-reset`,
    {
      method: "POST",
      headers: { "content-type": "application/json", origin: "rakazo://" },
      body: JSON.stringify({ email, redirectTo }),
    },
    {},
  );
  if (!response.ok) throw new Error(responseErrorMessage(body, t("Could not send reset email")));
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  const { response, body } = await fetchMobileJson<unknown>(
    `${currentApiBase()}/api/auth/change-password`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "rakazo://",
        ...(await authHeaders()),
      },
      body: JSON.stringify({ currentPassword, newPassword, revokeOtherSessions: true }),
    },
    {},
  );
  if (!response.ok) throw new Error(responseErrorMessage(body, t("Could not change password")));
}

async function fetchMobileJson<T>(
  input: Parameters<typeof fetch>[0],
  init: RequestInit,
  invalidJsonFallback?: T,
): Promise<{ response: Response; body: T }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Request timed out")), RPC_TIMEOUT_MS);
  try {
    const response = await withAbort(
      fetch(input, { ...init, signal: controller.signal }),
      controller.signal,
    );
    try {
      const body = await readBoundedJsonResponse<T>(
        response,
        MAX_MOBILE_AUTH_RESPONSE_BYTES,
        controller.signal,
      );
      return { response, body };
    } catch (error) {
      if (invalidJsonFallback !== undefined && error instanceof SyntaxError) {
        return { response, body: invalidJsonFallback };
      }
      throw error;
    }
  } finally {
    clearTimeout(timer);
  }
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
  const { response, body } = await fetchMobileJson<unknown>(
    `${currentApiBase()}/api/auth/delete-user`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "rakazo://",
        ...(await authHeaders()),
      },
      body: JSON.stringify({ password }),
    },
    {},
  );
  if (!response.ok) {
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
    skipSpaceAuthRecovery?: boolean;
  } = {},
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  const timer =
    options.timeoutMs === null ? undefined : setTimeout(abort, options.timeoutMs ?? RPC_TIMEOUT_MS);
  // Bind recovery to the Space + selection epoch this request was sent with:
  // a 401 arriving after the user switched Spaces — including A → B → A —
  // belongs to a stale request and must not touch the current selection.
  const requestSpaceGeneration = spaceSelectionGeneration;
  const requestHeaders = options.requestContext?.headers ?? (await authHeaders());
  const requestSpaceId = requestHeaders["x-rakazo-space-id"];
  try {
    const res = await fetch(`${options.requestContext?.apiBase ?? currentApiBase()}/rpc/${proc}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "rakazo://",
        ...requestHeaders,
      },
      body: JSON.stringify({ json: body }),
      signal: controller.signal,
    });
    const parsed = await readBoundedJsonResponse<{ json?: T; error?: { message?: string } }>(
      res,
      MAX_MOBILE_RPC_RESPONSE_BYTES,
      controller.signal,
    );
    if (!res.ok || parsed.error) {
      const message = parsed.error?.message ?? `rpc ${proc} failed`;
      const unauthorized = res.status === 401 || /unauthorized/i.test(message);
      // After a delete where SecureStore could not clear the stale id, restart
      // reloads it and the first RPCs 401. Probe once without a Space header:
      // success means the selection was inaccessible (clear it); failure means
      // the session itself is bad (restore the selection so a later sign-in
      // keeps the user's Space). Never replay a mutation against the default
      // Space — only safe reads may retry as themselves; other procs probe
      // with spaces/list, then fail the original call.
      const previousSpaceId = selectedSpaceId();
      // Clear stale selection records, then re-persist a Space selected while
      // cleanup was in flight: check-then-clear cannot be atomic on
      // SecureStore, so reconcile afterwards instead of trusting the check.
      const clearStaleSpaceSelection = async () => {
        await clearStoredValue(SPACE_KEY);
        await clearStoredValue(SPACE_ROLLBACK_KEY);
        const reselected = selectedSpaceId();
        if (reselected) await writeStoredValue(SPACE_KEY, reselected);
      };
      if (
        unauthorized &&
        previousSpaceId &&
        requestSpaceId &&
        selectedSpaceId() === requestSpaceId &&
        spaceSelectionGeneration === requestSpaceGeneration &&
        !options.requestContext &&
        !options.skipSpaceAuthRecovery
      ) {
        cachedSpaceId = "";
        bumpSpaceSelectionGeneration();
        const retrySameProc = SPACE_AUTH_RECOVERY_SAFE_PROCS.has(proc);
        // Share the original deadline/cancellation with recovery calls instead
        // of starting a second full timeout behind the first request.
        const recoveryOptions: {
          signal?: AbortSignal;
          timeoutMs?: number | null;
          requestContext?: ApiRequestContext;
          skipSpaceAuthRecovery?: boolean;
        } = {
          ...options,
          timeoutMs: null,
          signal: controller.signal,
          skipSpaceAuthRecovery: true,
        };
        try {
          if (retrySameProc) {
            const result = await rpc<T>(proc, body, recoveryOptions);
            // A Space selected while the retry was in flight already owns both
            // the in-memory and durable selection; leave it alone.
            if (!selectedSpaceId()) await clearStaleSpaceSelection();
            return result;
          }
          await rpc("spaces/list", {}, recoveryOptions);
        } catch (retryError) {
          if (!selectedSpaceId()) {
            cachedSpaceId = previousSpaceId;
            bumpSpaceSelectionGeneration();
          }
          throw retryError;
        }
        if (!selectedSpaceId()) await clearStaleSpaceSelection();
        throw new Error(message);
      }
      throw new Error(message);
    }
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
  | "modelProvider"
  | "modelId"
  | "thinkingLevel"
> &
  Partial<Pick<Bot, "parentBotId" | "spaceId">>;

export type MobileBotSection = BotSection;

export type MobileMe = Pick<
  Me,
  | "name"
  | "email"
  | "spaceId"
  | "defaultProvider"
  | "defaultModel"
  | "needsModel"
  | "avatarStyle"
  | "isDeploymentOwner"
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
  createdAt?: string;
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
  lark: "Feishu",
};

export function messagingProviderLabel(provider: string, transport?: string): string {
  if (provider === "sendblue" && ["iMessage", "SMS", "RCS"].includes(transport ?? "")) {
    return transport!;
  }
  return MESSAGING_PROVIDER_LABELS[provider] ?? provider;
}

export function copyableMobileMessageText(message: MobileMessage): string {
  return message.blocks
    .map((block) => {
      if (block.kind === "channel_message") {
        return `${messagingProviderLabel(block.provider, block.transport)} · ${block.fromLabel}: ${block.text}`;
      }
      if (block.kind === "text" || block.kind === "progress" || block.kind === "ask")
        return block.text;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function blockText(message: MobileMessage) {
  return message.blocks
    .map((block) => {
      if (block.kind === "channel_message") {
        return `${messagingProviderLabel(block.provider, block.transport)} · ${block.fromLabel}: ${block.text}`;
      }
      if (block.kind === "cloud_agent")
        return `${block.title}: ${block.status}${block.prUrl ? ` ${block.prUrl}` : ""}`;
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
  if (event.type === "run.waiting_input" || event.type === "computer.takeover.requested") {
    const status = event.type === "run.waiting_input" ? "waiting_input" : "waiting_takeover";
    const progressId = progressMessageId(event);
    // Waiting pauses drop live progress server-side; clear a leftover bubble so
    // the waiting footer is not hidden behind a stale "Working…" row.
    const messages = prev.messages.filter((message) => message.id !== progressId);
    const progressCleared = messages.length !== prev.messages.length;
    const runId = event.runId;
    const knownInRun = Boolean(runId && prev.run?.id === runId);
    const knownInActive = Boolean(
      runId && prev.activeRuns?.some((candidate) => candidate.id === runId),
    );
    // Peer bot_message runs are omitted from snapshots while busy; the first wait
    // event is how an open thread learns they need ask/takeover UI.
    const needsInsert = Boolean(runId) && !knownInRun && !knownInActive;
    const runChanged = Boolean(knownInRun && prev.run && prev.run.status !== status);
    const activeRunChanged = Boolean(
      knownInActive &&
        prev.activeRuns?.some((candidate) => candidate.id === runId && candidate.status !== status),
    );
    const computer =
      event.type === "computer.takeover.requested" && prev.computer?.busyBotName
        ? { ...prev.computer, busyBotName: null }
        : prev.computer;
    const computerChanged = computer !== prev.computer;
    const cursor = event.seq ?? prev.cursor;
    if (!runChanged && !activeRunChanged && !progressCleared && !needsInsert && !computerChanged) {
      return cursor === prev.cursor ? prev : { ...prev, cursor };
    }
    if (needsInsert && runId) {
      const waitingRun = {
        id: runId,
        status,
        ...(event.botId ? { botId: event.botId } : {}),
      };
      const baseActive = prev.activeRuns ?? (prev.run ? [prev.run] : []);
      const activeRuns = [...baseActive.filter((candidate) => candidate.id !== runId), waitingRun];
      const promoteWaiting =
        !prev.run ||
        (prev.run.status !== "waiting_input" && prev.run.status !== "waiting_takeover");
      return {
        ...prev,
        cursor,
        messages,
        computer,
        run: promoteWaiting ? waitingRun : prev.run,
        activeRuns,
      };
    }
    const run = runChanged && prev.run ? { ...prev.run, status } : prev.run;
    const activeRuns = activeRunChanged
      ? prev.activeRuns?.map((candidate) =>
          candidate.id === runId ? { ...candidate, status } : candidate,
        )
      : prev.activeRuns;
    return { ...prev, cursor, run, activeRuns, messages, computer };
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
    const { previous, remaining } = takeLiveMessage(prev.messages, progressId);
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
    const { previous, remaining } = takeLiveMessage(prev.messages, progressId);
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
  if (event.type === "agent.tool.completed") {
    return { ...prev, cursor: event.seq ?? prev.cursor };
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
  if (event.type === "thread.cloud_agent") {
    return {
      ...prev,
      cursor: event.seq ?? prev.cursor,
      messages: updateCloudAgentMessages(prev.messages, event.payload ?? {}),
    };
  }
  if (event.type === "thread.message.created" || event.type === "thread.message.updated") {
    const { remaining } = takeLiveMessage(prev.messages, progressMessageId(event));
    const next: MobileMessage = {
      id: String(event.payload?.messageId ?? event.id ?? `msg:${event.seq ?? 0}`),
      runId: event.runId ? String(event.runId) : undefined,
      role: (event.payload?.role as MobileMessage["role"]) ?? "bot",
      blocks: (event.payload?.blocks as MobileMessage["blocks"]) ?? [],
      botId: event.botId ?? (event.payload?.botId ? String(event.payload.botId) : undefined),
      replyToMessageId: event.payload?.replyToMessageId
        ? String(event.payload.replyToMessageId)
        : undefined,
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
