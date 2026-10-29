import type {
  AccountSecurity,
  AuthCapabilities,
  Bot,
  BotSection,
  ComputerStatus,
  Group,
  Me,
  MessageBlock,
  ModelCatalogEntry,
  ModelCredential,
  RpcInput,
  RpcOutput,
  RpcPath,
  Run,
  RunStatus,
  Space,
  SpaceNavigation,
  ThreadMessage,
  ThreadSnapshot,
} from "@rakazo/contracts";
import {
  accountSecuritySchema,
  authCapabilitiesSchema,
  CLIENT_UPDATE_REQUIRED_STATUS,
  legacyAccountSecurity,
  legacyAuthCapabilitiesSchema,
} from "@rakazo/contracts";
import type { ThreadHistory } from "@rakazo/core";
import {
  aiConsentTarget,
  aiDataUsesForProcedure,
  cancelResponseBody,
  displayIdentityEvent,
  displayIdentityResult,
  displayName,
  ensureAiDataConsent,
  isActive,
  isBackgroundRunTrigger,
  isRunTerminalEvent,
  isServerUnreachable,
  isUnreachableStatus,
  mergeThreadHistory,
  messagingProviderLabel,
  parseRetryAfter,
  prependThreadHistoryPage,
  progressMessageId,
  readBoundedJsonResponse,
  reduceLiveMessageBlocks,
  replyMetadata,
  runFailureError,
  settleRunSubagents,
  signupRequiresEmailVerification,
  stopsRunHelpers,
  takeLiveMessage,
  updateCloudAgentMessages,
  upsertMessageById,
  withAbort,
} from "@rakazo/core";
import { clientCorrelationHeaders, responseCorrelation } from "@rakazo/logging/monitoring";
import * as SecureStore from "expo-secure-store";
import { promptAiConsent } from "./ai-consent";
import type { EndpointResult } from "./endpoint";
import { defaultApiBase, normalizeApiBase } from "./endpoint";
import { t } from "./i18n";
import { identityLabels } from "./identity-display";
import { resumeLiveNotifications } from "./live-notifications";
import {
  beginMobileAvatarFeed,
  mobileLogoAvatarActivity,
  newMobileAvatarSnapshotRequest,
  rememberMobileAvatarSnapshot,
  syncMobileAvatarSession,
} from "./logo-avatar-activity";
import { reportMobileError } from "./monitoring";
import { API_BASE_STORAGE_KEY as ENDPOINT_KEY } from "./server-config";
import {
  clearSessionToken,
  currentSessionGeneration,
  loadSessionToken,
  replaceSessionTokenIfCurrent,
  restoreSessionToken,
  saveSessionToken,
  saveVerifiedIntegrationsScope,
  snapshotSessionToken,
  tokenFromAuthResponse,
} from "./session";
import { clearUnsentSends } from "./thread-feedback";
import { authResponseErrorText, errorText, sessionSaveErrorText } from "./user-error";

const SPACE_KEY = "rakazo.space_id";
const SPACE_ROLLBACK_KEY = "rakazo.space_rollback";
const RPC_TIMEOUT_MS = 8_000;
export const MAX_MOBILE_AUTH_RESPONSE_BYTES = 256 * 1024;
export const MAX_MOBILE_RPC_RESPONSE_BYTES = 16 * 1024 * 1024;
/** Inbox bootstrap reads safe to replay without a Space header during auth recovery. */
const SPACE_AUTH_RECOVERY_SAFE_PROCS = new Set(["spaces/list", "me"]);

let cachedApiBase: string | undefined;
const apiBaseListeners = new Set<() => void>();

export function subscribeApiBase(listener: () => void): () => void {
  apiBaseListeners.add(listener);
  return () => {
    apiBaseListeners.delete(listener);
  };
}

function setCachedApiBase(url: string): void {
  if (cachedApiBase !== undefined && cachedApiBase !== url) clearUnsentSends();
  cachedApiBase = url;
  for (const listener of apiBaseListeners) listener();
}
let cachedSpaceId = "";
/** Bumped on every in-memory Space selection change so a delayed response
 * cannot treat a later reselection of the same Space id as its own. */
let spaceSelectionGeneration = 0;
/** Counts selectSpace attempts so one still cleaning up a rollback record
 * cannot claim the selection after a newer attempt has started. */
let spaceSelectionRequestGeneration = 0;

/** Includes pending selections that have not claimed the in-memory space yet. */
export function spaceSelectionSeq(): number {
  return spaceSelectionRequestGeneration;
}

function bumpSpaceSelectionGeneration(): void {
  spaceSelectionGeneration += 1;
}

/** Keeps a timeout or cancel reason; turns transport and parsing detail into copy. */
function requestError(error: unknown, signal: AbortSignal): unknown {
  return signal.aborted ? (signal.reason ?? error) : new Error(errorText(error), { cause: error });
}

let serverReachable = true;
const serverReachableListeners = new Set<() => void>();

/** False from a request that could not reach the server until the server answers again. */
export function isServerReachable(): boolean {
  return serverReachable;
}

/** Calls `listener` each time the server stops or starts answering. */
export function subscribeServerReachable(listener: () => void): () => void {
  serverReachableListeners.add(listener);
  return () => {
    serverReachableListeners.delete(listener);
  };
}

function noteServerReachable(reachable: boolean): void {
  if (reachable === serverReachable) return;
  serverReachable = reachable;
  for (const listener of [...serverReachableListeners]) listener();
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
  setCachedApiBase(apiBase);
  try {
    const storedSpace = (await SecureStore.getItemAsync(SPACE_KEY)) ?? "";
    cachedSpaceId = storedSpace;
    bumpSpaceSelectionGeneration();
    // A deletion fallback must override the now-invalid saved Space even when
    // the device failed to replace that value before the previous process exited.
    await recoverSpaceRollback(apiBase);
  } catch {
    // Keep any in-memory selection when SecureStore is temporarily unavailable.
  }
  return currentApiBase();
}

export async function selectSpace(id: string) {
  const requestGeneration = ++spaceSelectionRequestGeneration;
  if (!(await clearStoredValue(SPACE_ROLLBACK_KEY))) return false;
  // Rollback cleanup is the first await. A newer selection may have claimed
  // the live space while this call was still deleting the rollback record.
  if (requestGeneration !== spaceSelectionRequestGeneration) return false;
  // Claim memory before persisting: recovery paths reconcile against the
  // in-memory selection, so a durable write must never precede its owner.
  const previousSpaceId = cachedSpaceId;
  cachedSpaceId = id;
  bumpSpaceSelectionGeneration();
  // Generation ownership distinguishes A→B→A from "we still own this claim":
  // an ID-only check would treat a later same-id selection as ours.
  const claimGeneration = spaceSelectionGeneration;
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
    if (cachedSpaceId === id && spaceSelectionGeneration === claimGeneration) {
      cachedSpaceId = previousSpaceId;
      bumpSpaceSelectionGeneration();
      const rollbackGeneration = spaceSelectionGeneration;
      if (previousSpaceId) await writeStoredValue(SPACE_KEY, previousSpaceId);
      if (previousSpaceId)
        await resumeSelectedSpaceNotifications(previousSpaceId, rollbackGeneration);
    }
    return false;
  }
  await resumeSelectedSpaceNotifications(id, claimGeneration);
  return true;
}

async function resumeSelectedSpaceNotifications(id: string, generation: number): Promise<void> {
  const apiBase = currentApiBase();
  const sessionGeneration = currentSessionGeneration();
  const token = await loadSessionToken();
  if (
    generation !== spaceSelectionGeneration ||
    sessionGeneration !== currentSessionGeneration() ||
    apiBase !== currentApiBase()
  )
    return;
  await resumeLiveNotifications(apiBase, token, id).catch(() => undefined);
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

export async function clearSpace(): Promise<boolean> {
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
  | {
      ok: true;
      previousToken: string;
      previousSpace: string;
    }
  | { ok: false; result: EndpointResult }
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
    return {
      ok: true,
      previousToken: previousToken.value,
      previousSpace: previousSpace.value,
    };
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
  let cleared:
    | {
        previousToken: string;
        previousSpace: string;
      }
    | undefined;
  if (parsed.url !== previous) {
    const result = await clearCredentialsForEndpointChange();
    if (!result.ok) return result.result;
    cleared = result;
  }
  try {
    await SecureStore.setItemAsync(ENDPOINT_KEY, parsed.url);
  } catch {
    if (cleared) {
      await restoreCredentials(cleared.previousToken, cleared.previousSpace);
    }
    return { ok: false, error: t("Could not save the server URL") };
  }
  setCachedApiBase(parsed.url);
  await clearStoredValue(SPACE_ROLLBACK_KEY);
  return parsed;
}

export async function resetApiBase(): Promise<EndpointResult> {
  const previous = currentApiBase();
  const url = defaultApiBase();
  let cleared:
    | {
        previousToken: string;
        previousSpace: string;
      }
    | undefined;
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
  setCachedApiBase(url);
  await clearStoredValue(SPACE_ROLLBACK_KEY);
  return { ok: true, url };
}

let clientBuild: { headers: () => Record<string, string>; onUpdateRequired: () => void } = {
  headers: () => ({}),
  onUpdateRequired: () => {},
};

/** The app names its build on every request and decides what a refused build does. */
export function configureClientBuild(options: typeof clientBuild): void {
  clientBuild = options;
}

export async function authHeaders(
  spaceId: string | null = selectedSpaceId(),
): Promise<Record<string, string>> {
  const token = await loadSessionToken();
  return {
    ...clientBuild.headers(),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
  };
}

export type ApiRequestContext = {
  sessionGeneration?: number;
  apiBase: string;
  headers: Record<string, string>;
};

/** Keeps consent prompts separate across servers and the selected Space. */
export function aiConsentCoalesceKey(requestContext: ApiRequestContext): string {
  return [requestContext.apiBase, requestContext.headers["x-rakazo-space-id"] ?? ""].join("\u0000");
}

/** Pins a request to the current server and session, and to a Space (the selected one by default). */
export async function captureApiRequestContext(
  spaceId: string | null = selectedSpaceId(),
): Promise<ApiRequestContext> {
  const generation = currentSessionGeneration();
  const apiBase = currentApiBase();
  const headers = await authHeaders(spaceId);
  if (apiBase !== currentApiBase()) {
    throw new Error(t("The server changed while starting the request"));
  }
  if (generation !== currentSessionGeneration())
    throw new Error(t("Something went wrong. Try again."));
  return { apiBase, headers, sessionGeneration: generation };
}

async function postAuth(path: string, input: Record<string, string>) {
  return fetchMobileJson<unknown>(
    `${currentApiBase()}/api/auth/${path}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", origin: "rakazo://" },
      body: JSON.stringify(input),
    },
    {},
  );
}

async function authenticate(
  path: string,
  input: Record<string, string>,
  missingSession: string,
): Promise<{ verificationRequired: boolean }> {
  const { response, body, invalidJson } = await postAuth(path, input);
  if (!response.ok || invalidJson) {
    throw new Error(authResponseErrorText(response.status, body, invalidJson));
  }
  const token = tokenFromAuthResponse(response, body);
  if (path === "sign-up/email" && signupRequiresEmailVerification(body))
    return { verificationRequired: true };
  if (!token) throw new Error(missingSession);
  try {
    if (!(await clearSpace()))
      throw new Error(t("Could not save your sign-in on this device. Try again."));
    await saveSessionToken(token);
  } catch (error) {
    throw new Error(sessionSaveErrorText(error));
  }
  return { verificationRequired: false };
}

export function signIn(email: string, password: string) {
  return authenticate("sign-in/email", { email, password }, t("Sign-in did not return a session"));
}

export function signUp(email: string, password: string, name: string) {
  return authenticate(
    "sign-up/email",
    { email, password, name },
    t("Sign-up did not return a session"),
  );
}

/** Always succeeds when the server accepts the request, whether or not an email was sent. */
export async function sendSignInCode(email: string): Promise<void> {
  const { response, body, invalidJson } = await postAuth("email-otp/send-verification-otp", {
    email,
    type: "sign-in",
  });
  if (!response.ok) throw new Error(authResponseErrorText(response.status, body, invalidJson));
}

/** Signs in with an emailed code, creating the account (with `name`) when none exists. */
export async function signInWithCode(email: string, code: string, name?: string): Promise<void> {
  await authenticate(
    "sign-in/email-otp",
    { email, otp: code, ...(name ? { name } : {}) },
    t("Sign-in did not return a session"),
  );
}

export type PasswordResetCapabilities = AuthCapabilities;

export async function passwordResetCapabilities(): Promise<PasswordResetCapabilities> {
  const { response, body } = await fetchMobileJson<unknown>(
    `${currentApiBase()}/api/auth/capabilities`,
    { headers: { origin: "rakazo://" } },
  );
  if (!response.ok) throw new Error(t("Could not load sign-in options"));
  return authCapabilitiesSchema.or(legacyAuthCapabilitiesSchema).parse(body);
}

export async function requestPasswordReset(email: string, redirectTo: string): Promise<void> {
  const { response, body, invalidJson } = await fetchMobileJson<unknown>(
    `${currentApiBase()}/api/auth/request-password-reset`,
    {
      method: "POST",
      headers: { "content-type": "application/json", origin: "rakazo://" },
      body: JSON.stringify({ email, redirectTo }),
    },
    {},
  );
  if (!response.ok)
    throw new Error(
      authResponseErrorText(response.status, body, invalidJson, t("Could not send reset email")),
    );
}

export async function updateAccountName(name: string): Promise<void> {
  const nextName = name.trim();
  if (!nextName || nextName.length > 80 || !displayName(nextName, "")) {
    throw new Error(t("Could not update name"));
  }
  const { response, body, invalidJson } = await fetchMobileJson<unknown>(
    `${currentApiBase()}/api/auth/update-user`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "rakazo://",
        ...(await authHeaders()),
      },
      body: JSON.stringify({ name: nextName }),
    },
    {},
  );
  if (!response.ok)
    throw new Error(
      authResponseErrorText(response.status, body, invalidJson, t("Could not update name")),
    );
}

/** Revoking other sessions also refuses this one until the replacement is saved. */
let passwordChangesInFlight = 0;

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  passwordChangesInFlight += 1;
  try {
    await replaceSessionAfterPasswordChange(currentPassword, newPassword);
  } finally {
    passwordChangesInFlight -= 1;
  }
}

async function replaceSessionAfterPasswordChange(currentPassword: string, newPassword: string) {
  const apiBase = currentApiBase();
  const generation = currentSessionGeneration();
  const headers = await authHeaders();
  const { response, body, invalidJson } = await fetchMobileJson<unknown>(
    `${apiBase}/api/auth/change-password`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "rakazo://",
        ...headers,
      },
      body: JSON.stringify({ currentPassword, newPassword, revokeOtherSessions: true }),
    },
    {},
  );
  if (!response.ok)
    throw new Error(
      authResponseErrorText(response.status, body, invalidJson, t("Could not change password")),
    );
  // Revoking other sessions also revokes this one; keep the replacement the server issued.
  const token = tokenFromAuthResponse(response, body);
  if (!token) return;
  // A sign-out or server switch changes the session while the request is in flight.
  if (currentApiBase() !== apiBase) return;
  const maybeResume = async () => {
    // Our save is the only change allowed; a sign-out during it must not restart notifications.
    const spaceId = selectedSpaceId();
    if (spaceId && currentSessionGeneration() === generation + 1) {
      await resumeLiveNotifications(apiBase, token, spaceId).catch(() => undefined);
    }
  };
  try {
    if (!(await replaceSessionTokenIfCurrent(generation, token))) return;
  } catch (error) {
    // The replacement is already in memory; resume before the keychain error reaches the UI.
    await maybeResume();
    throw error;
  }
  await maybeResume();
}

export async function fetchMobileJson<T>(
  input: Parameters<typeof fetch>[0],
  init: RequestInit,
  invalidJsonFallback?: T,
): Promise<{ response: Response; body: T; invalidJson?: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Request timed out")), RPC_TIMEOUT_MS);
  try {
    const response = await withAbort(
      fetch(input, { ...init, signal: controller.signal }),
      controller.signal,
      "Request timed out",
    ).catch((error: unknown) => {
      throw requestError(error, controller.signal);
    });
    try {
      const body = await readBoundedJsonResponse<T>(
        response,
        MAX_MOBILE_AUTH_RESPONSE_BYTES,
        controller.signal,
      );
      return { response, body };
    } catch (error) {
      if (invalidJsonFallback !== undefined && error instanceof SyntaxError) {
        return { response, body: invalidJsonFallback, invalidJson: true };
      }
      throw requestError(error, controller.signal);
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
        body: "{}",
        signal: controller.signal,
      }),
      controller.signal,
      "Request timed out",
    ).catch(() => undefined);
  } finally {
    clearTimeout(timer);
  }
  const sessionCleared = await clearSessionToken();
  const spaceCleared = await clearSpace();
  if (!sessionCleared || !spaceCleared) throw new Error(t("Could not clear the local session"));
}

export async function deleteAccount(password?: string, token?: string) {
  await rpc("notifications/unregisterPush").catch(() => undefined);
  const { response, body, invalidJson } = await fetchMobileJson<unknown>(
    `${currentApiBase()}/api/auth/delete-user`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "rakazo://",
        ...(await authHeaders()),
      },
      body: JSON.stringify({ password, token }),
    },
    {},
  );
  if (!response.ok) {
    throw new Error(
      authResponseErrorText(response.status, body, invalidJson, t("Could not delete account")),
    );
  }
  await clearSessionToken();
  await clearSpace();
}

const sessionRejectedListeners = new Set<() => void>();

/** Runs after the server rejected the stored session and it was cleared. */
export function subscribeSessionRejected(listener: () => void): () => void {
  sessionRejectedListeners.add(listener);
  return () => {
    sessionRejectedListeners.delete(listener);
  };
}

async function rejectSession() {
  await clearSessionToken();
  for (const listener of sessionRejectedListeners) listener();
}

export type RpcOptions = {
  signal?: AbortSignal;
  timeoutMs?: number | null;
  requestContext?: ApiRequestContext;
  skipSpaceAuthRecovery?: boolean;
};

/** The body may be left out when the procedure takes none or every field is optional. */
export type RpcArgs<P extends RpcPath> =
  undefined extends RpcInput<P>
    ? [body?: RpcInput<P>, options?: RpcOptions]
    : // biome-ignore lint/complexity/noBannedTypes: an input whose fields are all optional
      {} extends RpcInput<P>
      ? [body?: RpcInput<P>, options?: RpcOptions]
      : [body: RpcInput<P>, options?: RpcOptions];

/** Calls a procedure from the shared contract; its path picks the body and result types. */
export function rpc<P extends RpcPath>(proc: P, ...[body, options]: RpcArgs<P>) {
  return request(proc, body, options) as Promise<RpcOutput<P>>;
}

async function request(
  proc: RpcPath,
  body: unknown = {},
  options: RpcOptions = {},
): Promise<unknown> {
  syncMobileAvatarSession(currentApiBase(), currentSessionGeneration());
  const avatarSnapshotOrder = proc === "threads/get" ? newMobileAvatarSnapshotRequest() : 0;
  const requestSpaceGeneration = spaceSelectionGeneration;
  const requestSessionGeneration = currentSessionGeneration();
  const requestApiBase = options.requestContext?.apiBase ?? currentApiBase();
  const uses = aiDataUsesForProcedure(proc, body);
  const consentTarget = aiConsentTarget(body);
  const consentContext =
    options.requestContext ?? (uses.length ? await captureApiRequestContext() : undefined);
  await ensureAiDataConsent({
    uses,
    status: () =>
      rpc("aiConsent/status", { uses, ...consentTarget }, { requestContext: consentContext }),
    prompt: promptAiConsent,
    allow: (input) =>
      rpc(
        "aiConsent/allow",
        consentTarget.settingsScope
          ? { ...input, settingsScope: consentTarget.settingsScope }
          : input,
        { requestContext: consentContext },
      ),
    coalesceKey: consentContext ? aiConsentCoalesceKey(consentContext) : undefined,
  });
  // Abort with an explicit reason so every consumer of the signal (the fetch, the bounded body
  // read, and nested recovery calls that share this signal) reports the same cause.
  const controller = new AbortController();
  const cancel = () => controller.abort(options.signal?.reason ?? new Error("Request canceled"));
  if (options.signal?.aborted) cancel();
  else options.signal?.addEventListener("abort", cancel, { once: true });
  const timer =
    options.timeoutMs === null
      ? undefined
      : setTimeout(
          () =>
            controller.abort(
              Object.defineProperty(new Error("Request timed out"), "name", {
                value: "TimeoutError",
              }),
            ),
          options.timeoutMs ?? RPC_TIMEOUT_MS,
        );
  // Bind recovery to the Space + selection epoch this request was sent with:
  // a 401 arriving after the user switched Spaces — including A → B → A —
  // belongs to a stale request and must not touch the current selection.
  const requestHeaders = consentContext?.headers ?? (await authHeaders());
  const requestSpaceId = requestHeaders["x-rakazo-space-id"];
  try {
    if (
      consentContext?.sessionGeneration !== undefined &&
      consentContext.sessionGeneration !== currentSessionGeneration()
    )
      throw new Error(t("Something went wrong. Try again."));
    let res: Response;
    const correlation = clientCorrelationHeaders();
    try {
      res = await fetch(`${consentContext?.apiBase ?? currentApiBase()}/rpc/${proc}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "rakazo://",
          ...requestHeaders,
          ...correlation,
        },
        body: JSON.stringify({ json: body }),
        signal: controller.signal,
      });
    } catch (error) {
      // The native fetch reports an aborted request with an implementation detail
      // ("FetchRequestCanceledException") and an unreachable server with a native stack
      // location; say what happened instead.
      if (!controller.signal.aborted)
        reportMobileError(error, "rpc.transport", responseCorrelation(new Headers(correlation)));
      throw requestError(error, controller.signal);
    }
    if (
      requestSessionGeneration === currentSessionGeneration() &&
      requestApiBase === currentApiBase()
    )
      noteServerReachable(!isUnreachableStatus(res.status));
    if (proc === "aiConsent/status" && res.status === 404) {
      cancelResponseBody(res);
      throw new Error(t("Update your server to use AI data sharing in this mobile version."));
    }
    const parsed: { json?: unknown } = await readBoundedJsonResponse<{ json?: unknown }>(
      res,
      MAX_MOBILE_RPC_RESPONSE_BYTES,
      controller.signal,
    ).catch((error: unknown) => {
      // A proxy, or a server without this procedure, can fail with a body that is not JSON.
      if (!res.ok && error instanceof SyntaxError) return {};
      throw requestError(error, controller.signal);
    });
    if (!res.ok) {
      // oRPC sends a failure as `{ json: { code, status, message } }`; the message is the
      // server's user-facing copy.
      const error = parsed.json as
        | { message?: unknown; code?: unknown; data?: unknown }
        | undefined;
      const message = errorText(typeof error?.message === "string" ? error.message : "");
      const unauthorized = res.status === 401;
      // Without a Space header a 401 means the server no longer accepts the
      // session itself; Space recovery below probes the same way. Clearing it
      // bumps the session generation, so only the first rejection of a session
      // acts, and a 401 sent before a newer sign-in or a password change on
      // this device cannot clear the session that replaced it.
      if (
        unauthorized &&
        !requestSpaceId &&
        requestHeaders.authorization &&
        !options.requestContext &&
        !passwordChangesInFlight &&
        requestSessionGeneration === currentSessionGeneration()
      ) {
        await rejectSession();
      }
      // After a delete where SecureStore could not clear the stale id, restart
      // reloads it and the first RPCs 401. Probe once without a Space header:
      // success means the selection was inaccessible (clear it); failure means
      // the session itself is bad (restore the selection; it stays until
      // sign-in resets it). Never replay a mutation against the default
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
        if (!reselected) return;
        // Own the reconcile write by generation: a newer selection that
        // persists between snapshot and write must not be overwritten by
        // this stale id, and a write that lands stale heals once to live.
        const writeGeneration = spaceSelectionGeneration;
        await writeStoredValue(SPACE_KEY, reselected);
        if (spaceSelectionGeneration !== writeGeneration) {
          const live = selectedSpaceId();
          if (live) await writeStoredValue(SPACE_KEY, live);
        }
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
        const recoveryOptions: RpcOptions = {
          ...options,
          timeoutMs: null,
          signal: controller.signal,
          skipSpaceAuthRecovery: true,
        };
        try {
          if (retrySameProc) {
            const result = await request(proc, body, recoveryOptions);
            // A Space selected while the retry was in flight already owns both
            // the in-memory and durable selection; leave it alone.
            if (!selectedSpaceId()) await clearStaleSpaceSelection();
            return result;
          }
          await request("spaces/list", {}, recoveryOptions);
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
      throw Object.assign(
        httpError(message, res, typeof error?.code === "string" ? error.code : undefined),
        { data: error?.data },
      );
    }
    const verifiedUser = parsed.json as { userId?: unknown; spaceId?: unknown } | null;
    if (
      proc === "me" &&
      typeof verifiedUser?.userId === "string" &&
      typeof verifiedUser.spaceId === "string"
    ) {
      await saveVerifiedIntegrationsScope(requestSessionGeneration, {
        apiBase: requestApiBase,
        userId: verifiedUser.userId,
        spaceId: requestSpaceId || verifiedUser.spaceId,
        selectionId: requestSpaceId ?? null,
      });
    }
    if (
      proc === "threads/get" &&
      requestSessionGeneration === currentSessionGeneration() &&
      requestApiBase === currentApiBase()
    ) {
      const snapshot = parsed.json as ThreadSnapshot;
      if (typeof snapshot?.threadId === "string" && typeof snapshot.cursor === "number")
        rememberMobileAvatarSnapshot(snapshot, avatarSnapshotOrder);
    }
    return displayIdentityResult(proc.split("/"), parsed.json, identityLabels());
  } catch (error) {
    if (
      requestSessionGeneration === currentSessionGeneration() &&
      requestApiBase === currentApiBase() &&
      isServerUnreachable(error)
    )
      noteServerReachable(false);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}

export type MobileBot = Pick<
  Bot,
  | "id"
  | "name"
  | "preview"
  | "color"
  | "avatarSet"
  | "instructionHistory"
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
  | "autoSpeak"
  | "fleetManagement"
  | "crossSpaceCommunication"
> &
  Partial<Pick<Bot, "parentBotId" | "spaceId" | "instructions">>;

export type MobileBotSection = BotSection;

export type MobileMe = Pick<
  Me,
  | "userId"
  | "name"
  | "email"
  | "spaceId"
  | "defaultProvider"
  | "defaultModel"
  | "hostCredentialProvider"
  | "hostCredentialSource"
  | "needsModel"
  | "isDeploymentOwner"
  | "needsSignupSurvey"
  | "billingEnabled"
  | "paymentWalletProvider"
>;

export type MobileModel = ModelCatalogEntry;

/** Shared DTO includes headerNames only; header values remain in the server secret. */
export type MobileModelCredential = ModelCredential;

/** Live progress and streaming rows are shown before they have a seq, thread, or time. */
export type MobileMessage = Omit<ThreadMessage, "threadId" | "seq" | "createdAt"> &
  Partial<Pick<ThreadMessage, "threadId" | "seq" | "createdAt">>;

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

/** A run as live events report it, before a refresh brings the full record. */
type MobileRun = Pick<Run, "id"> & Partial<Pick<Run, "botId" | "userId">> & { status: string };

/**
 * A thread as the screen holds it: live events patch it between refreshes, and a saved chat
 * reopens without its cursor, runs, or computer.
 */
export type MobileSnapshot = Omit<
  ThreadSnapshot,
  "cursor" | "messages" | "run" | "activeRuns" | "computer"
> & {
  cursor?: ThreadSnapshot["cursor"];
  messages: MobileMessage[];
  run: (MobileRun & Partial<Pick<Run, "error">>) | null;
  activeRuns?: MobileRun[];
  computer?: Pick<
    ComputerStatus,
    "state" | "controlHolder" | "screenAvailable" | "mode" | "busyBotName"
  >;
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

/**
 * What a refresh may hand the live subscription. The server replays events
 * after this snapshot's cursor, so an uncommitted fetch must not supply it.
 */
export function mobileThreadRefreshResult(input: {
  fetched: MobileSnapshot;
  onScreen: MobileSnapshot | null;
  requestGeneration: number;
  currentGeneration: number;
  requestEpoch: number;
  currentEpoch: number;
  targetBotId: string | undefined;
  targetGroupId: string | undefined;
  activeBotId: string | undefined;
  activeGroupId: string | undefined;
}): { commit: boolean; snapshot: MobileSnapshot | null } {
  // Live events may advance the screen while this snapshot is in flight.
  const commit =
    input.requestGeneration === input.currentGeneration &&
    shouldApplyMobileThreadRefresh(input) &&
    (input.onScreen?.threadId !== input.fetched.threadId ||
      (input.fetched.cursor ?? -1) >= (input.onScreen.cursor ?? -1));
  return { commit, snapshot: commit ? input.fetched : input.onScreen };
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

export { messagingProviderLabel };

function channelMessageLine(block: {
  provider: Parameters<typeof messagingProviderLabel>[0];
  transport?: Parameters<typeof messagingProviderLabel>[1];
  fromLabel: string;
  text: string;
}): string {
  return `${block.fromLabel} (${messagingProviderLabel(block.provider, block.transport)}): ${block.text}`;
}

/** The message's text exactly as written, for a view that selects part of it. */
export function selectableMobileMessageText(message: MobileMessage): string {
  return message.blocks
    .map((block) => {
      if (block.kind === "channel_message") {
        return channelMessageLine(block);
      }
      if (block.kind === "text" || block.kind === "progress" || block.kind === "ask")
        return block.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function copyableMobileMessageText(message: MobileMessage): string {
  return selectableMobileMessageText(message).trim();
}

export function blockText(message: MobileMessage) {
  return message.blocks
    .map((block) => {
      if (block.kind === "channel_message") {
        return channelMessageLine(block);
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
          .join(", ");
      }
      return ("text" in block ? block.text : "state" in block ? block.state : "") ?? "";
    })
    .filter(Boolean)
    .join("\n");
}

type ThreadEvent = {
  id?: string;
  createdAt?: string;
  botId?: string;
  type: string;
  seq?: number;
  runId?: string;
  threadId?: string;
  payload?: Record<string, unknown>;
};

/** No frame at all for this long means the stream is half-open; the server beats far faster. */
export const IDLE_TIMEOUT_MS = 45_000;

/**
 * A failed response as an error the shared retry policy can read: its status, oRPC code, and any
 * Retry-After. A 426 also asks the user to update, from whichever request noticed it.
 */
function httpError(message: string, res: Response, code?: string): Error {
  if (res.status === CLIENT_UPDATE_REQUIRED_STATUS) clientBuild.onUpdateRequired();
  return Object.defineProperties(new Error(message), {
    status: { value: res.status },
    // oRPC's error code; a proxy's bare 404 has none.
    code: { value: code },
    retryAfterMs: { value: parseRetryAfter(res.headers.get("retry-after")) },
  });
}

export async function subscribeThread(
  target: { botId: string } | { groupId: string },
  cursor: number,
  onEvent: (event: ThreadEvent) => void,
  signal: AbortSignal,
) {
  const context = await captureApiRequestContext();
  syncMobileAvatarSession(currentApiBase(), currentSessionGeneration());
  const activityFeed = beginMobileAvatarFeed(target, cursor);
  const current = () =>
    context.apiBase === currentApiBase() &&
    context.sessionGeneration === currentSessionGeneration();
  const res = await fetch(`${context.apiBase}/rpc/threads/subscribe`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      origin: "rakazo://",
      ...context.headers,
    },
    body: JSON.stringify({ json: { ...target, cursor } }),
    signal,
  }).catch((error: unknown) => {
    mobileLogoAvatarActivity.resetSource(activityFeed.source);
    if (current() && !signal.aborted && isServerUnreachable(error)) noteServerReachable(false);
    throw error;
  });
  if (current()) noteServerReachable(!isUnreachableStatus(res.status));
  if (!res.ok || !res.body) {
    mobileLogoAvatarActivity.resetSource(activityFeed.source);
    cancelResponseBody(res);
    throw httpError(`rpc threads/subscribe failed (${res.status})`, res);
  }
  const reader = res.body.getReader();
  let finished = false;
  try {
    const decoder = new TextDecoder();
    let scratch: Uint8Array | undefined;
    let used = 0;
    let previousLf = false;
    const appendFrameBytes = (bytes: Uint8Array) => {
      const required = used + bytes.byteLength;
      if (!scratch || scratch.byteLength < required) {
        const capacity = Math.min(
          MAX_MOBILE_RPC_RESPONSE_BYTES,
          Math.max(required, scratch ? scratch.byteLength * 2 : 1024),
        );
        const grown = new Uint8Array(capacity);
        if (scratch && used) grown.set(scratch.subarray(0, used));
        scratch = grown;
      }
      scratch.set(bytes, used);
      used = required;
    };
    const emitFrame = (bytes: Uint8Array) => {
      const data = decoder
        .decode(bytes)
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
      if (!data || data === "[DONE]") return;
      try {
        const parsed = JSON.parse(data) as { json?: ThreadEvent; error?: { message?: string } };
        // Heartbeats prove liveness only; forwarding one would advance the caller's cursor.
        if (parsed.json?.type && parsed.json.type !== "heartbeat") {
          if (!current()) {
            mobileLogoAvatarActivity.resetSource(activityFeed.source);
            return;
          }
          const event = parsed.json;
          const threadId = event.threadId ?? activityFeed.threadId;
          if (threadId && typeof event.seq === "number" && event.seq > cursor)
            mobileLogoAvatarActivity.apply(activityFeed.source, {
              threadId,
              seq: event.seq,
              botId: event.botId,
              runId: event.runId,
              type: event.type,
              payload: event.payload ?? {},
            });
          onEvent(displayIdentityEvent(event, identityLabels()));
        }
      } catch {
        // Malformed frames and callback errors do not interrupt the subscription.
      }
    };
    while (!signal.aborted) {
      // A half-open socket never reports done, so let the caller reconnect after silence.
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const read = await Promise.race([
        reader.read().catch((error) => {
          if (current() && !signal.aborted && isServerUnreachable(error))
            noteServerReachable(false);
          throw error;
        }),
        new Promise<"idle" | "aborted">((resolve) => {
          timer = setTimeout(() => resolve("idle"), IDLE_TIMEOUT_MS);
          onAbort = () => resolve("aborted");
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        }),
      ]).finally(() => {
        clearTimeout(timer);
        if (onAbort) signal.removeEventListener("abort", onAbort);
      });
      if (read === "idle" || read === "aborted") return;
      const { done, value } = read;
      if (done) {
        finished = true;
        break;
      }
      let start = 0;
      for (let index = 0; index < value.byteLength; index += 1) {
        if (used + index - start >= MAX_MOBILE_RPC_RESPONSE_BYTES) {
          throw new RangeError(`Thread SSE frame exceeds ${MAX_MOBILE_RPC_RESPONSE_BYTES} bytes`);
        }
        const isLf = value[index] === 10;
        if (previousLf && isLf) {
          let frame: Uint8Array = value.subarray(start, index + 1);
          if (used) {
            appendFrameBytes(frame);
            frame = scratch!.subarray(0, used);
          }
          emitFrame(frame);
          used = 0;
          previousLf = false;
          start = index + 1;
        } else {
          previousLf = isLf;
        }
      }
      if (start < value.byteLength) appendFrameBytes(value.subarray(start));
    }
  } finally {
    mobileLogoAvatarActivity.resetSource(activityFeed.source);
    if (!finished) {
      try {
        void Promise.resolve(reader.cancel()).catch(() => undefined);
      } catch {
        // Cancellation is best-effort and must not delay releasing the reader.
      }
    }
    reader.releaseLock();
  }
}

export function applyMobileThreadEvent(
  prev: MobileSnapshot | null,
  event: ThreadEvent,
): MobileSnapshot | null {
  if (!prev || event.type === "heartbeat") return prev;
  if (stopsRunHelpers(event)) {
    const messages = settleRunSubagents(prev.messages, event.runId);
    if (messages !== prev.messages) prev = { ...prev, messages };
  }
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
  if (event.type === "run.started") {
    const cursor = event.seq ?? prev.cursor;
    const trigger = typeof event.payload?.trigger === "string" ? event.payload.trigger : undefined;
    if (isBackgroundRunTrigger(trigger)) {
      return cursor === prev.cursor ? prev : { ...prev, cursor };
    }
    const members =
      event.botId &&
      prev.members?.some((member) => member.botId === event.botId && member.status !== "running")
        ? prev.members.map((member) =>
            member.botId === event.botId ? { ...member, status: "running" } : member,
          )
        : prev.members;
    if (!event.runId) {
      return cursor === prev.cursor && members === prev.members
        ? prev
        : { ...prev, cursor, members };
    }
    const previousRun =
      prev.activeRuns?.find((candidate) => candidate.id === event.runId) ??
      (prev.run?.id === event.runId ? prev.run : undefined);
    const run = {
      ...previousRun,
      id: event.runId,
      status: "running",
      ...(event.botId ? { botId: event.botId } : {}),
      error: null,
    };
    const activeRuns = [
      ...(prev.activeRuns ?? (prev.run ? [prev.run] : [])).filter(
        (candidate) => candidate.id !== run.id && isActive(candidate.status as RunStatus),
      ),
      run,
    ];
    return {
      ...prev,
      cursor,
      members,
      // Keep a group failure visible while another member starts work.
      run: prev.groupId && prev.run?.status === "failed" && prev.run.id !== run.id ? prev.run : run,
      activeRuns,
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
    const userId =
      event.type === "run.waiting_input" && typeof event.payload?.userId === "string"
        ? event.payload.userId
        : undefined;
    const knownInRun = Boolean(runId && prev.run?.id === runId);
    const knownInActive = Boolean(
      runId && prev.activeRuns?.some((candidate) => candidate.id === runId),
    );
    // Peer bot_message runs are omitted from snapshots while busy; the first wait
    // event is how an open thread learns they need ask/takeover UI.
    const needsInsert = Boolean(runId) && !knownInRun && !knownInActive;
    const runChanged = Boolean(
      knownInRun &&
        prev.run &&
        (prev.run.status !== status || (userId !== undefined && prev.run.userId !== userId)),
    );
    const activeRunChanged = Boolean(
      knownInActive &&
        prev.activeRuns?.some(
          (candidate) =>
            candidate.id === runId &&
            (candidate.status !== status || (userId !== undefined && candidate.userId !== userId)),
        ),
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
        ...(userId !== undefined ? { userId } : {}),
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
    const run =
      runChanged && prev.run
        ? { ...prev.run, status, ...(userId !== undefined ? { userId } : {}) }
        : prev.run;
    const activeRuns = activeRunChanged
      ? prev.activeRuns?.map((candidate) =>
          candidate.id === runId
            ? { ...candidate, status, ...(userId !== undefined ? { userId } : {}) }
            : candidate,
        )
      : prev.activeRuns;
    return { ...prev, cursor, run, activeRuns, messages, computer };
  }
  if (event.type === "computer.takeover.released") {
    const runId = event.runId;
    const settle = <T extends { id: string; status: string }>(candidate: T): T =>
      runId && candidate.id === runId && candidate.status === "waiting_takeover"
        ? { ...candidate, status: "queued" }
        : candidate;
    const nextRun = prev.run ? settle(prev.run) : prev.run;
    const activeChanged = Boolean(
      runId &&
        prev.activeRuns?.some(
          (candidate) => candidate.id === runId && candidate.status === "waiting_takeover",
        ),
    );
    const cursor = event.seq ?? prev.cursor;
    if (nextRun === prev.run && !activeChanged) {
      return cursor === prev.cursor ? prev : { ...prev, cursor };
    }
    const members = prev.members?.some(
      (member) => member.botId === event.botId && member.status === "waiting_takeover",
    )
      ? prev.members.map((member) =>
          member.botId === event.botId ? { ...member, status: "queued" } : member,
        )
      : prev.members;
    return {
      ...prev,
      cursor,
      run: nextRun,
      activeRuns: activeChanged ? prev.activeRuns?.map(settle) : prev.activeRuns,
      members,
    };
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
    const id = String(event.payload?.messageId ?? event.id ?? `msg:${event.seq ?? 0}`);
    const known = prev.messages.find((message) => message.id === id);
    const seq = typeof event.payload?.seq === "number" ? event.payload.seq : known?.seq;
    const next: MobileMessage = {
      id,
      // Inline cards act on the message's thread, so live messages need it too.
      threadId: known?.threadId ?? prev.threadId,
      // The seq lets a send that is still on screen as "Sending…" recognize its echo.
      ...(seq === undefined ? {} : { seq }),
      createdAt: known?.createdAt ?? event.createdAt,
      runId: event.runId ? String(event.runId) : undefined,
      role: (event.payload?.role as MobileMessage["role"]) ?? "bot",
      // An update can leave the call id out — the `end_call` marker does — so keep the one
      // the message already carries instead of dropping it out of its call.
      callId: typeof event.payload?.callId === "string" ? event.payload.callId : known?.callId,
      blocks: (event.payload?.blocks as MobileMessage["blocks"]) ?? [],
      botId: event.botId ?? (event.payload?.botId ? String(event.payload.botId) : undefined),
      ...replyMetadata(event.payload ?? {}, known),
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

export async function fetchAccountSecurity(): Promise<AccountSecurity> {
  const { response, body } = await fetchMobileJson<unknown>(
    `${currentApiBase()}/api/auth/account-security`,
    { headers: { origin: "rakazo://", ...(await authHeaders()) } },
    null,
  );
  // Older servers support password accounts and the original change/delete endpoints.
  if (response.status === 404) return legacyAccountSecurity;
  if (!response.ok) throw new Error(t("Could not load sign-in options"));
  try {
    return accountSecuritySchema.parse(body);
  } catch {
    throw new Error(t("Could not load sign-in options"));
  }
}

async function postSignedInAuth(path: string, payload: Record<string, string> = {}): Promise<void> {
  const { response, body, invalidJson } = await fetchMobileJson<unknown>(
    `${currentApiBase()}/api/auth${path}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "rakazo://",
        ...(await authHeaders()),
      },
      body: JSON.stringify(payload),
    },
    null,
  );
  if (!response.ok)
    throw new Error(
      authResponseErrorText(response.status, body, invalidJson, t("Could not continue")),
    );
}

export const requestAccountDeletionCode = () => postSignedInAuth("/request-account-deletion");

/** Emails a confirmation code to an account without a password. */
export const requestIdentityCode = () => postSignedInAuth("/request-identity-code");

/** Confirms this session's identity for the next few minutes. */
export const confirmIdentity = (proof: { password: string } | { code: string }) =>
  postSignedInAuth("/confirm-identity", proof);
