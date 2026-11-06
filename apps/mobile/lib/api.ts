import type {
  AccountSecurity,
  AuthCapabilities,
  Bot,
  BotSection,
  ComputerStatus,
  Group,
  IncomingBotCall,
  Me,
  ModelCatalogEntry,
  ModelCredential,
  RpcInput,
  RpcOutput,
  RpcPath,
  Space,
  SpaceNavigation,
  ThreadSnapshot,
} from "@rakazo/contracts";
import {
  accountSecuritySchema,
  authCapabilitiesSchema,
  CLIENT_UPDATE_REQUIRED_STATUS,
  IncomingBotCallSchema,
  legacyAccountSecurity,
  legacyAuthCapabilitiesSchema,
  parseServerHeaders,
} from "@rakazo/contracts";
import type { LiveThreadMessage, LiveThreadRun, ThreadHistory } from "@rakazo/core";
import {
  aiConsentTargets,
  aiDataUsesForProcedure,
  cancelResponseBody,
  channelMessageLine,
  displayIdentityEvent,
  displayIdentityResult,
  displayName,
  ensureAiDataConsent,
  isServerUnreachable,
  isUnreachableStatus,
  messagingProviderLabel,
  parseRetryAfter,
  prependThreadHistoryPage,
  readBoundedJsonResponse,
  signupRequiresEmailVerification,
  withAbort,
} from "@rakazo/core";
import { clientCorrelationHeaders, responseCorrelation } from "@rakazo/logging/monitoring";
import * as SecureStore from "expo-secure-store";
import { promptAiConsent } from "./ai-consent";
import type { EndpointResult } from "./endpoint";
import { defaultApiBase, normalizeApiBase } from "./endpoint";
import { getActiveUiLocale, t } from "./i18n";
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
import { followSelectedSpace, selectedSpaceChanged } from "./referral";
import { API_BASE_STORAGE_KEY as ENDPOINT_KEY } from "./server-config";
import { fetchServer, loadServerHeaders, saveServerHeaders, serverHeaders } from "./server-headers";
import {
  clearSessionToken,
  currentSessionGeneration,
  loadSessionToken,
  restoreSessionToken,
  rotateSessionTokenIfCurrent,
  saveRotatedSessionToken,
  saveSessionToken,
  saveVerifiedIntegrationsScope,
  sessionOnlyInMemory,
  sessionSaveInProgress,
  snapshotSessionToken,
  snapshotStoredSessionToken,
  tokenFromAuthResponse,
} from "./session";
import { clearUnsentSends } from "./thread-feedback";
import { authResponseErrorText, errorText, sessionSaveErrorText } from "./user-error";

const SPACE_KEY = "rakazo.space_id";
const SPACE_ROLLBACK_KEY = "rakazo.space_rollback";
/** The Space last used in each organization on this device, by organization id. */
const ORGANIZATION_SPACES_KEY = "rakazo.org_spaces";
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
followSelectedSpace(() => cachedSpaceId || null);
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
  // Another Space can belong to another organization, with its own invite link.
  selectedSpaceChanged();
}

/** Orders complete endpoint transactions, including credential rollback. */
let endpointChangeQueue: Promise<unknown> = Promise.resolve();

/** Runs an endpoint change in order, holding the reconcile gate while it switches servers. */
function queueEndpointChange(
  url: string,
  change: (previous: string, switching: boolean) => Promise<EndpointResult>,
): Promise<EndpointResult> {
  const result = endpointChangeQueue.then(async () => {
    const previous = currentApiBase();
    const switching = url !== previous;
    if (switching) endpointChanges += 1;
    try {
      return await change(previous, switching);
    } finally {
      if (switching) endpointChanges -= 1;
    }
  });
  endpointChangeQueue = result.catch(() => undefined);
  return result;
}

const confirmedSpaceSwitchListeners = new Set<() => void>();

/** Fires when a selection change to another Space is confirmed durable; a
 * rollback after a failed switch, or selecting the same Space again, does not. */
export function subscribeConfirmedSpaceSwitch(listener: () => void): () => void {
  confirmedSpaceSwitchListeners.add(listener);
  return () => {
    confirmedSpaceSwitchListeners.delete(listener);
  };
}

function noteConfirmedSpaceSwitch(): void {
  for (const listener of [...confirmedSpaceSwitchListeners]) listener();
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
  if (reachable !== serverReachable) {
    serverReachable = reachable;
    for (const listener of [...serverReachableListeners]) listener();
  }
  // Every answered request is also a connectivity window for a revocation still pending.
  if (reachable) void flushPendingSignOut();
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
  await loadServerHeaders(apiBase);
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
  // A revocation left pending by an earlier sign-out or server switch retries on this launch.
  void flushPendingSignOut(true);
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
  // Playback belongs to the conversation being left; the listener in voice.ts
  // stops it once a switch to another Space is confirmed. A fallback that
  // failed to persist left its origin pending; this confirmed switch consumes
  // it, so the fallback's retry cannot stop this Space's later playback.
  if ((pendingFallbackSwitchFrom ?? previousSpaceId) !== id) noteConfirmedSpaceSwitch();
  pendingFallbackSwitchFrom = null;
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
/** The Space the user was actually on before a fallback adoption that has not
 * landed yet; a retry that persists must still count as leaving it. */
let pendingFallbackSwitchFrom: string | null = null;

export async function adoptDeletedSpaceFallback(id: string): Promise<boolean> {
  const previousSpaceId = cachedSpaceId;
  if (pendingFallbackSwitchFrom === null && previousSpaceId !== id) {
    pendingFallbackSwitchFrom = previousSpaceId;
  }
  cachedSpaceId = id;
  bumpSpaceSelectionGeneration();
  // Neutralize any same-endpoint rollback before writing SPACE_KEY. Writing the
  // selection first can leave it beside a stale record that recoverSpaceRollback
  // would prefer on restart if later cleanup fails.
  const rollbackNeutralized =
    (await clearStoredValue(SPACE_ROLLBACK_KEY)) || (await saveSpaceRollback(id));
  // Playback belongs to the conversation being left; the fallback too is a
  // confirmed switch once it durably adopts another Space. A failed attempt
  // already claimed the replacement in memory, so the Space remembered before
  // the first attempt, not the claim, decides whether one was left behind.
  if (rollbackNeutralized && (await writeStoredValue(SPACE_KEY, id))) {
    // SPACE_KEY is authoritative; drop a rollback we may have written only to
    // overwrite a stale record (best-effort).
    await clearStoredValue(SPACE_ROLLBACK_KEY);
    if ((pendingFallbackSwitchFrom ?? previousSpaceId) !== id) noteConfirmedSpaceSwitch();
    pendingFallbackSwitchFrom = null;
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
  const durable =
    recoverySaved || (staleSelectionCleared && (await clearStoredValue(SPACE_ROLLBACK_KEY)));
  if (durable && (pendingFallbackSwitchFrom ?? previousSpaceId) !== id) {
    noteConfirmedSpaceSwitch();
  }
  if (durable) pendingFallbackSwitchFrom = null;
  return durable;
}

export async function selectInitialSpace(id: string) {
  if (selectedSpaceId()) return true;
  return selectSpace(id);
}

export async function loadOrganizationSpaces(): Promise<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(
      (await SecureStore.getItemAsync(ORGANIZATION_SPACES_KEY)) || "{}",
    );
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.fromEntries(
          Object.entries(parsed).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : {};
  } catch {
    return {};
  }
}

export async function rememberOrganizationSpace(
  organizationId: string,
  spaceId: string,
): Promise<void> {
  const spaces = await loadOrganizationSpaces();
  await writeStoredValue(
    ORGANIZATION_SPACES_KEY,
    JSON.stringify({ ...spaces, [organizationId]: spaceId }),
  );
}

export async function clearSpace(): Promise<boolean> {
  const organizationsCleared = await clearStoredValue(ORGANIZATION_SPACES_KEY);
  const spaceCleared = await clearStoredValue(SPACE_KEY);
  const rollbackCleared = await clearStoredValue(SPACE_ROLLBACK_KEY);
  if (!organizationsCleared || !spaceCleared || !rollbackCleared) return false;
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

/**
 * Hangs up an active call while its session can still authorize the hang-up. Set by the call
 * module; a server switch runs it before it discards the old server's session, which would
 * otherwise leave the old server holding an answered call with no marker or wrap-up.
 */
let hangUpBeforeCredentialsCleared: (() => Promise<void>) | undefined;

/** Registers (or clears) the hang-up that runs before an endpoint change clears credentials. */
export function configureSessionEndHangUp(hangUp: (() => Promise<void>) | undefined): void {
  hangUpBeforeCredentialsCleared = hangUp;
}

type ClearedCredentials = {
  previousToken: string;
  previousSpace: string;
  /** The revocation owed to the previous server, recorded before its credentials are discarded. */
  pendingSignOut: PendingSignOut | undefined;
};

/**
 * Clears session + space for an endpoint change. Restores both if either wipe fails. The session it
 * clears is the one it records for revocation: a sign-in during the hang-up is read here, and any
 * session change after that read stops the switch before it clears anything.
 */
async function clearCredentialsForEndpointChange(
  previous: string,
  previousHeaders: Record<string, string>,
): Promise<({ ok: true } & ClearedCredentials) | { ok: false; result: EndpointResult }> {
  // The old server's session authorizes the call's hang-up; send it while it still exists.
  await hangUpBeforeCredentialsCleared?.().catch(() => undefined);
  const generation = currentSessionGeneration();
  // A save still running reads as no session; its token may land before the clear.
  const previousToken = sessionSaveInProgress()
    ? ({ ok: false } as const)
    : await snapshotSessionToken();
  // A failed save or wipe can leave a token stored that reads as no session. A restart would send
  // it again, so the switch revokes it too, but restores only the session in use.
  const revokedToken =
    previousToken.ok && !previousToken.value ? await snapshotStoredSessionToken() : previousToken;
  // An unreadable session is not an empty one: clearing now could strand a live session
  // with no record to revoke it, so the switch stops before touching anything.
  if (!previousToken.ok || !revokedToken.ok) {
    return {
      ok: false,
      result: { ok: false, error: t("Could not save the previous server session") },
    };
  }
  let pendingSignOut: PendingSignOut | undefined;
  if (revokedToken.value) {
    // Recorded before the old credentials are discarded, so a process kill cannot lose both —
    // but provisionally: a retry must not revoke a session a rolled-back switch still uses.
    pendingSignOut = {
      apiBase: previous,
      token: revokedToken.value,
      headers: previousHeaders,
      recordedAt: Date.now(),
      provisional: true,
    };
    if (!(await savePendingSignOut(pendingSignOut))) {
      // Without the record the old server keeps its session, so the switch cannot proceed.
      return {
        ok: false,
        result: { ok: false, error: t("Could not save the previous server session") },
      };
    }
  }
  // `restoredToken` is the session the device still has; until the clear, that is the recorded one.
  const failed = async (restoredToken = revokedToken.value) => {
    await settleRolledBackSignOut(pendingSignOut, restoredToken);
    return {
      ok: false as const,
      result: { ok: false as const, error: t("Could not clear the previous server session") },
    };
  };
  // Captured before the read, so a selection made during it cannot pass as the one read.
  const spaceGeneration = spaceSelectionGeneration;
  const previousSpace = await snapshotSpace();
  if (!previousSpace.ok) return failed();
  const rollbackReady = previousSpace.value
    ? await saveSpaceRollback(previousSpace.value)
    : await clearStoredValue(SPACE_ROLLBACK_KEY);
  if (!rollbackReady) return failed();
  // Checked in the same tick as the clear: a session saved after the read has no record.
  if (generation !== currentSessionGeneration()) {
    // An earlier failed switch may have left the rollback as the selection's only stored copy.
    let kept = true;
    if (previousSpace.value && spaceSelectionGeneration === spaceGeneration) {
      kept = await writeStoredValue(SPACE_KEY, previousSpace.value);
      // A selection made during a write may have landed first; store the live one again until a
      // write completes with no selection made during it.
      let written = spaceGeneration;
      while (spaceSelectionGeneration !== written) {
        written = spaceSelectionGeneration;
        kept = cachedSpaceId
          ? await writeStoredValue(SPACE_KEY, cachedSpaceId)
          : await clearStoredValue(SPACE_KEY);
      }
    }
    if (kept) await clearStoredValue(SPACE_ROLLBACK_KEY);
    return failed();
  }
  const sessionCleared = await clearSessionToken();
  cachedSpaceId = "";
  bumpSpaceSelectionGeneration();
  const spaceCleared = await clearStoredValue(SPACE_KEY);
  // The clear is the only session change allowed. A sign-in during it saved a session for the old
  // server: the switch must not carry it to the new one, and a restore would overwrite it. The
  // cleared session is gone from the device, so its record stays.
  if (currentSessionGeneration() !== generation + 1) return failed("");
  if (sessionCleared && spaceCleared) {
    return {
      ok: true,
      previousToken: previousToken.value,
      previousSpace: previousSpace.value,
      pendingSignOut,
    };
  }

  return failed(await restoreCredentials(previousToken.value, previousSpace.value));
}

/**
 * Settles a rolled-back switch's revocation record. The rollback restores only the session in use,
 * and only a restore that stored it removes the record. Any other record stays provisional: the
 * next retry delivers it, unless that token is the active session again.
 */
async function settleRolledBackSignOut(
  record: PendingSignOut | undefined,
  restoredToken: string,
): Promise<void> {
  if (record && record.token === restoredToken) await removePendingSignOut(record);
}

/** Rolls back an endpoint change that cleared credentials, settling its revocation record. */
async function rollBackEndpointChange(cleared: ClearedCredentials | undefined): Promise<void> {
  if (!cleared) return;
  const restoredToken = await restoreCredentials(cleared.previousToken, cleared.previousSpace);
  await settleRolledBackSignOut(cleared.pendingSignOut, restoredToken);
}

/** Returns the restored token, or "" when it is kept only in memory and a restart would lose it. */
async function restoreCredentials(previousToken: string, previousSpace: string): Promise<string> {
  let persisted = !previousToken || (await restoreSessionToken(previousToken));
  if (!persisted) {
    // A clear that failed too may have left the token stored, where a restart still finds it.
    const stored = await snapshotStoredSessionToken();
    persisted = stored.ok && stored.value === previousToken;
  }
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
  return persisted ? previousToken : "";
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

export async function saveApiBase(
  input: string,
  headers: Record<string, string> = {},
): Promise<EndpointResult> {
  const parsed = normalizeApiBase(input);
  if (!parsed.ok) return parsed;
  if (parsed.url === defaultApiBase() && Object.keys(headers).length === 0) return resetApiBase();
  return queueEndpointChange(parsed.url, async (previous, switching) => {
    const previousHeaders = serverHeaders(previous);
    let cleared: ClearedCredentials | undefined;
    if (switching) {
      const result = await clearCredentialsForEndpointChange(previous, previousHeaders);
      if (!result.ok) return result.result;
      cleared = result;
    }
    if (!(await saveServerHeaders(parsed.url, headers))) {
      await rollBackEndpointChange(cleared);
      return { ok: false, error: t("Could not save the server URL") };
    }
    try {
      await SecureStore.setItemAsync(ENDPOINT_KEY, parsed.url);
    } catch {
      await saveServerHeaders(previous, previousHeaders);
      await rollBackEndpointChange(cleared);
      return { ok: false, error: t("Could not save the server URL") };
    }
    setCachedApiBase(parsed.url);
    await clearStoredValue(SPACE_ROLLBACK_KEY);
    if (cleared?.pendingSignOut) await promotePendingSignOut(cleared.pendingSignOut);
    if (cleared) await clearStoredValue(ORGANIZATION_SPACES_KEY);
    return parsed;
  });
}

export async function resetApiBase(): Promise<EndpointResult> {
  const url = defaultApiBase();
  return queueEndpointChange(url, async (previous, switching) => {
    let cleared: ClearedCredentials | undefined;
    if (switching) {
      const result = await clearCredentialsForEndpointChange(previous, serverHeaders(previous));
      if (!result.ok) return result.result;
      cleared = result;
    }
    try {
      await SecureStore.deleteItemAsync(ENDPOINT_KEY);
    } catch {
      if (cleared) {
        await rollBackEndpointChange(cleared);
        return { ok: false, error: t("Could not clear the custom server URL") };
      }
    }
    if (!(await saveServerHeaders(url, {}))) {
      if (await writeStoredValue(ENDPOINT_KEY, previous)) {
        await rollBackEndpointChange(cleared);
      } else {
        // Without the old server URL stored again, the next launch opens the default server, so
        // this launch follows it too: the old session is not restored, its record stays for the
        // next retry to revoke, and a later sign-in's token is never sent to another server.
        setCachedApiBase(url);
        if (cleared) await clearStoredValue(ORGANIZATION_SPACES_KEY);
      }
      return { ok: false, error: t("Could not clear the custom server URL") };
    }
    setCachedApiBase(url);
    await clearStoredValue(SPACE_ROLLBACK_KEY);
    if (cleared?.pendingSignOut) await promotePendingSignOut(cleared.pendingSignOut);
    if (cleared) await clearStoredValue(ORGANIZATION_SPACES_KEY);
    return { ok: true, url };
  });
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

async function postAuth(path: string, input: Record<string, string>, apiBase = currentApiBase()) {
  return fetchMobileJson<unknown>(
    `${apiBase}/api/auth/${path}`,
    {
      method: "POST",
      // The app authenticates by bearer token only; a server's cookie must not outlive a switch.
      credentials: "omit",
      // Emails sent before an account has a language follow the one this app shows.
      headers: {
        "content-type": "application/json",
        origin: "rakazo://",
        "accept-language": getActiveUiLocale(),
      },
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
  const apiBase = currentApiBase();
  const generation = currentSessionGeneration();
  // A switch replaces the stored headers, and the cleanup below may still need them for this server.
  const headers = serverHeaders(apiBase);
  const { response, body, invalidJson } = await postAuth(path, input, apiBase);
  if (!response.ok || invalidJson) {
    throw new Error(authResponseErrorText(response.status, body, invalidJson));
  }
  const token = tokenFromAuthResponse(response, body);
  if (path === "sign-up/email" && signupRequiresEmailVerification(body))
    return { verificationRequired: true };
  if (!token) throw new Error(missingSession);
  // A server switch or sign-out while the request was in flight: this token belongs to a server
  // the app no longer uses, so it is never saved and its session is ended there.
  let saved = false;
  if (apiBase === currentApiBase() && generation === currentSessionGeneration()) {
    try {
      if (!(await clearSpace()))
        throw new Error(t("Could not save your sign-in on this device. Try again."));
      // Checked in the same tick the save starts; a failed write leaves no session behind.
      if (apiBase === currentApiBase() && generation === currentSessionGeneration()) {
        await saveSessionToken(token);
        // A change that lands while the token is being written clears it again.
        saved = currentSessionGeneration() === generation + 1 && apiBase === currentApiBase();
      }
    } catch (error) {
      throw new Error(sessionSaveErrorText(error));
    }
  }
  if (!saved) {
    // Recorded like a sign-out, so a server that cannot be reached now still ends it later.
    const revocation: PendingSignOut = { apiBase, token, headers, recordedAt: Date.now() };
    void deliverSignOutRecord(revocation, await savePendingSignOut(revocation));
    throw new Error(t("Could not continue"));
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
      headers: {
        "content-type": "application/json",
        origin: "rakazo://",
        "accept-language": getActiveUiLocale(),
      },
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
export function passwordChangeInFlight() {
  return passwordChangesInFlight > 0;
}
/** A hash of the change whose new session is not saved yet; never the passwords themselves. */
let unsavedPasswordChange: string | undefined;

/** A 53-bit hash, so an unchanged form can be recognized without keeping its passwords. */
function submissionHash(currentPassword: string, newPassword: string) {
  const text = JSON.stringify([currentPassword, newPassword]);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  passwordChangesInFlight += 1;
  const submission = submissionHash(currentPassword, newPassword);
  try {
    // An earlier change whose new session was not saved is finished first, so this change is sent
    // with that session; if it still cannot be saved, nothing new is submitted.
    const saved = await saveRotatedSessionToken();
    const finished = unsavedPasswordChange;
    unsavedPasswordChange = undefined;
    // The server already accepted this exact change; sending it again would fail.
    if (saved && finished === submission) return;
    await replaceSessionAfterPasswordChange(currentPassword, newPassword, submission);
  } finally {
    passwordChangesInFlight -= 1;
  }
}

async function replaceSessionAfterPasswordChange(
  currentPassword: string,
  newPassword: string,
  submission: string,
) {
  const apiBase = currentApiBase();
  const generation = currentSessionGeneration();
  const headers = await authHeaders();
  // The token the server replaces is the one this request carries; a second read could differ.
  const previousToken = headers.authorization?.slice("Bearer ".length) ?? "";
  // Without it the cookie jar could still sign the change, and the queue could not move over.
  if (!previousToken) throw new Error(t("Could not change password"));
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
    // The same account on the same server keeps its unsent messages.
    if (!(await rotateSessionTokenIfCurrent(generation, previousToken, token))) return;
  } catch (error) {
    unsavedPasswordChange = submission;
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
      fetchServer(
        input,
        {
          ...init,
          signal: controller.signal,
        },
        currentApiBase(),
      ),
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

const PENDING_SIGN_OUT_KEY = "rakazo.pending_sign_out";
/**
 * Better-auth expires a session 7 days after its last use, and the signed-out session is not used
 * again; 30 days also covers longer server overrides.
 */
const PENDING_SIGN_OUT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Answered-request retries wait at least this long, so a dead old server is not retried per request. */
const PENDING_SIGN_OUT_FLUSH_SPACING_MS = 60_000;
/** Storage safety cap for the record list; with everything unexpired, the oldest go first. */
const PENDING_SIGN_OUT_LIMIT = 100;

/**
 * A sign-out or server switch whose revocation has not reached its server yet. Kept in the same
 * secure storage as the session, because the token is what the revocation must present.
 */
type PendingSignOut = {
  apiBase: string;
  token: string;
  headers: Record<string, string>;
  /** When this record was written, so an age bound can retire undeliverable ones. */
  recordedAt: number;
  /** A server switch's record is deliverable only once the switch has committed. */
  provisional?: boolean;
};

/** Records are keyed by server and session, so each signed-out account keeps its own revocation. */
function samePendingSignOut(left: PendingSignOut, right: PendingSignOut): boolean {
  return left.apiBase === right.apiBase && left.token === right.token;
}

type PendingSignOutRead = { ok: true; records: PendingSignOut[] } | { ok: false };

/** Records whose session may still be alive on its server. */
function livePendingSignOuts(records: PendingSignOut[]): PendingSignOut[] {
  const now = Date.now();
  return records.filter((record) => now - record.recordedAt < PENDING_SIGN_OUT_MAX_AGE_MS);
}

/**
 * True once a retry confirmed no record is stored, so answered requests stop re-reading the store.
 * Unknown until then: a launch that cannot read the store leaves answered requests to retry it.
 */
let pendingSignOutAbsent = false;
/** When the last answered-request retry started; launch retries ignore it. */
let lastPendingSignOutFlushAt = 0;
/** The one in-flight flush; triggers that arrive meanwhile join it instead of starting their own. */
let flushingPendingSignOut: Promise<void> | undefined;
/** Delivery attempts in flight, keyed by the session each one revokes (server base, token). */
const deliveringSignOuts = new Map<string, Promise<void>>();
/** Orders every read-modify-write of the record list; network calls never run inside it. */
let pendingSignOutWrites: Promise<unknown> = Promise.resolve();
/** Endpoint changes in flight; reconcile leaves a switch's records alone while any runs. */
let endpointChanges = 0;

function queuePendingSignOutWrite<T>(step: () => Promise<T>): Promise<T> {
  const result = pendingSignOutWrites.then(step, step);
  pendingSignOutWrites = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function readPendingSignOuts(): Promise<PendingSignOutRead> {
  let stored: string | null = null;
  try {
    stored = await SecureStore.getItemAsync(PENDING_SIGN_OUT_KEY);
  } catch {
    // The store could not be read; the retry stays for a later connectivity window.
    return { ok: false };
  }
  if (!stored) return { ok: true, records: [] };
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) throw new Error("not a record list");
    const records: PendingSignOut[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as {
        apiBase?: unknown;
        token?: unknown;
        headers?: unknown;
        recordedAt?: unknown;
        provisional?: unknown;
      };
      if (typeof record.apiBase !== "string" || !record.apiBase) continue;
      if (typeof record.token !== "string" || !record.token) continue;
      if (typeof record.recordedAt !== "number" || !Number.isFinite(record.recordedAt)) continue;
      records.push({
        apiBase: record.apiBase,
        token: record.token,
        headers: parseServerHeaders(record.headers) ?? {},
        recordedAt: record.recordedAt,
        ...(record.provisional === true ? { provisional: true } : {}),
      });
    }
    return { ok: true, records };
  } catch {
    // A list this app cannot read counts as empty, and the next write replaces it; the sessions
    // expire server-side regardless.
    return { ok: true, records: [] };
  }
}

function writePendingSignOuts(records: PendingSignOut[]): Promise<boolean> {
  return writeStoredValue(PENDING_SIGN_OUT_KEY, JSON.stringify(records));
}

/** Records a revocation to deliver later. False when the store could not be read or written. */
async function savePendingSignOut(record: PendingSignOut): Promise<boolean> {
  return queuePendingSignOutWrite(async () => {
    const read = await readPendingSignOuts();
    if (!read.ok) return false;
    const kept = livePendingSignOuts(read.records).filter(
      (existing) => !samePendingSignOut(existing, record),
    );
    kept.unshift(record);
    if (!(await writePendingSignOuts(kept.slice(0, PENDING_SIGN_OUT_LIMIT)))) return false;
    pendingSignOutAbsent = false;
    // A fresh record gets its first retry at once, whatever an older record last attempted.
    lastPendingSignOutFlushAt = 0;
    return true;
  });
}

/**
 * Rewrites the stored records in the write queue, leaving an unreadable store alone. `transform`
 * returns the new list, or nothing when no record changes. A write that changes how many records
 * are stored also updates `pendingSignOutAbsent`.
 */
async function updatePendingSignOuts(
  transform: (records: PendingSignOut[]) => PendingSignOut[] | undefined,
): Promise<void> {
  await queuePendingSignOutWrite(async () => {
    const read = await readPendingSignOuts();
    if (!read.ok) return;
    const updated = transform(read.records);
    if (!updated) return;
    if ((await writePendingSignOuts(updated)) && updated.length !== read.records.length) {
      pendingSignOutAbsent = updated.length === 0;
    }
  });
}

/** Removes the captured record, preserving a newer sign-out that replaced a provisional one. */
async function removePendingSignOut(record: PendingSignOut): Promise<void> {
  await updatePendingSignOuts((records) => {
    const kept = records.filter(
      (existing) =>
        !samePendingSignOut(existing, record) ||
        existing.recordedAt !== record.recordedAt ||
        Boolean(existing.provisional) !== Boolean(record.provisional),
    );
    return kept.length === records.length ? undefined : kept;
  });
}

/** Marks a switch's provisional record deliverable, once the switch has committed. */
async function promotePendingSignOut(record: PendingSignOut): Promise<void> {
  await updatePendingSignOuts((records) => {
    let promoted = false;
    const kept = records.map((existing) => {
      if (!existing.provisional || !samePendingSignOut(existing, record)) return existing;
      promoted = true;
      const { provisional, ...committed } = existing;
      return committed;
    });
    return promoted ? kept : undefined;
  });
}

/**
 * Resolves records a dying server switch left behind. A provisional record whose session is still
 * the active one on its server belongs to a switch that never completed, and the session it would
 * revoke is still in use; every other provisional record is promoted for delivery. Everything is
 * revalidated inside the queued step — a switch may start, finish or roll back while this waits —
 * so a reconcile that raced a switch's start leaves its records alone.
 */
async function reconcileProvisionalSignOuts(): Promise<void> {
  await queuePendingSignOutWrite(async () => {
    const read = await readPendingSignOuts();
    if (!read.ok || !read.records.some((record) => record.provisional)) return;
    if (endpointChanges > 0) return;
    const generation = currentSessionGeneration();
    const saving = sessionSaveInProgress();
    const snapshot = await snapshotSessionToken();
    if (!snapshot.ok) return;
    // Re-read after the snapshot's wait too: nothing between this check and the write awaits,
    // so a switch that starts now queues its own record behind this step.
    if (endpointChanges > 0) return;
    // A running save reads as no session, so its token would count as inactive. A later pass
    // resolves this server's records instead of waiting for the save; other servers' go on.
    const unsettled = saving || generation !== currentSessionGeneration();
    const activeToken = snapshot.value;
    let resolvedAny = false;
    const resolved: PendingSignOut[] = [];
    for (const record of livePendingSignOuts(read.records)) {
      if (!record.provisional) {
        resolved.push(record);
        continue;
      }
      const onCurrentServer = record.apiBase === currentApiBase();
      if (onCurrentServer && unsettled) {
        resolved.push(record);
        continue;
      }
      const stillActive = onCurrentServer && record.token === activeToken;
      // A session kept only in memory is gone after a restart; a later reconcile promotes its record.
      if (stillActive && sessionOnlyInMemory()) {
        resolved.push(record);
        continue;
      }
      resolvedAny = true;
      if (!stillActive) {
        const { provisional, ...committed } = record;
        resolved.push(committed);
      }
    }
    if (resolvedAny) await writePendingSignOuts(resolved);
  });
}

/**
 * Sends a pending revocation to its server. Success or 401 (the session is already invalid)
 * completes it; the server's sign-out also ends that session's push registration. Everything
 * else — a refusing proxy, throttling, a server failure, no connection — retries.
 */
async function deliverPendingSignOut(record: PendingSignOut): Promise<"delivered" | "retry"> {
  const url = `${record.apiBase}/api/auth/sign-out`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    const response = await withAbort(
      // Not fetchServer: it reads the headers configured for the current server, and after
      // a switch those belong to the new one — only the record still carries this server's.
      fetch(url, {
        method: "POST",
        // Reject redirects where supported; native fetch also needs response validation below.
        redirect: "error",
        // Bearer only: this server's cookie must not reach the jar other servers share.
        credentials: "omit",
        headers: {
          "content-type": "application/json",
          origin: "rakazo://",
          authorization: `Bearer ${record.token}`,
          ...clientBuild.headers(),
          ...record.headers,
        },
        body: "{}",
        signal: controller.signal,
      }),
      controller.signal,
      "Request timed out",
    );
    // Native fetch can follow redirects; only the sign-out endpoint itself confirms delivery.
    if (response.url) {
      const requested = new URL(url);
      const answered = new URL(response.url);
      if (
        answered.origin !== requested.origin ||
        answered.pathname.replace(/\/$/, "") !== requested.pathname
      ) {
        return "retry";
      }
    } else if (response.redirected) {
      return "retry";
    }
    return response.ok || response.status === 401 ? "delivered" : "retry";
  } catch {
    return "retry";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Delivers a record once at a time: callers share the attempt in flight for the same session
 * (server base, token), so the revocation is never sent twice; unrelated records deliver
 * independently. A persisted record is delivered only while the store still holds it, so one an
 * earlier attempt completed is not sent again; an unreadable store falls back to the captured
 * record, as does one that could not be persisted.
 */
function deliverSignOutRecord(record: PendingSignOut, persisted = true): Promise<void> {
  const key = `${record.apiBase}\n${record.token}`;
  const inFlight = deliveringSignOuts.get(key);
  if (inFlight) return inFlight;
  const delivery = (async () => {
    try {
      const read = persisted ? await readPendingSignOuts() : ({ ok: false } as const);
      const current = read.ok
        ? livePendingSignOuts(read.records).find(
            (candidate) => samePendingSignOut(candidate, record) && !candidate.provisional,
          )
        : record;
      if (current && (await deliverPendingSignOut(current)) === "delivered") {
        await removePendingSignOut(current);
      }
    } catch {
      // Delivery problems never surface; the record waits for the next pass.
    } finally {
      deliveringSignOuts.delete(key);
    }
  })();
  deliveringSignOuts.set(key, delivery);
  return delivery;
}

async function pendingSignOutPass(): Promise<void> {
  try {
    lastPendingSignOutFlushAt = Date.now();
    await reconcileProvisionalSignOuts();
    // This read decides whether later non-forced flushes may skip the store, so it takes
    // its turn in the write queue: an out-of-queue read can resume after a queued sign-out
    // recorded a revocation and still report the store it saw first, silencing retries.
    // Records whose session cannot be alive anymore are retired in the same step. Delivery
    // stays outside the queue, like every network call.
    const read = await queuePendingSignOutWrite(async () => {
      const current = await readPendingSignOuts();
      if (!current.ok) {
        pendingSignOutAbsent = false;
        return current;
      }
      const live = livePendingSignOuts(current.records);
      if (live.length !== current.records.length) await writePendingSignOuts(live);
      pendingSignOutAbsent = live.length === 0;
      return { ok: true as const, records: live };
    });
    if (!read.ok) return;
    for (const record of read.records) {
      // A provisional record belongs to a switch that has not committed; it is not delivered.
      if (record.provisional) continue;
      // Removal is by record, so a revocation recorded during this pass is not touched.
      await deliverSignOutRecord(record);
    }
  } catch {
    // Records stay; the next connectivity window tries again.
  }
}

/**
 * Retries revocations that could not be delivered, until each server answers.
 * `force` reads the store even when the last attempt found nothing, for launch. Every attempt
 * first resolves provisional records a switch left behind by dying mid-change.
 */
export async function flushPendingSignOut(force = false): Promise<void> {
  if (!force && pendingSignOutAbsent) return;
  // Answered requests arrive in bursts; a permanently dead old server must not be hit
  // after each one for the record's whole life. Launch retries are never spaced out.
  if (!force && Date.now() - lastPendingSignOutFlushAt < PENDING_SIGN_OUT_FLUSH_SPACING_MS) return;
  flushingPendingSignOut ??= pendingSignOutPass().finally(() => {
    flushingPendingSignOut = undefined;
  });
  return flushingPendingSignOut;
}

export async function signOut() {
  const apiBase = currentApiBase();
  // A save still running reads as no session, and the clear would delete its token once it lands
  // with no record to revoke it: as in a server switch, the sign-out stops and the user retries.
  if (sessionSaveInProgress()) throw new Error(t("Could not clear the local session"));
  const generation = currentSessionGeneration();
  const tokenSnapshot = await snapshotSessionToken();
  if (!tokenSnapshot.ok) throw new Error(t("Could not clear the local session"));
  // A failed save or wipe can leave a token stored that reads as no session; the clear deletes it
  // too. An unreadable store only skips that record: signing out still clears this device.
  const stored = tokenSnapshot.value ? undefined : await snapshotStoredSessionToken();
  // A sign-in that started during the first read may have stored its token by the second one;
  // that token is the session in use, not the one being signed out.
  if (stored && (generation !== currentSessionGeneration() || sessionSaveInProgress())) {
    throw new Error(t("Could not clear the local session"));
  }
  const revocation: PendingSignOut = {
    apiBase,
    token: tokenSnapshot.value || (stored?.ok ? stored.value : ""),
    headers: serverHeaders(apiBase),
    recordedAt: Date.now(),
  };
  // The record is written before the attempts: an app that dies mid-sign-out still revokes later.
  // A failed write cannot block the local sign-out; the session still expires server-side.
  const persisted = revocation.token ? await savePendingSignOut(revocation) : false;
  // A sign-in that saved its token since the read has no record; as in a server switch, the
  // sign-out stops without clearing it. The record stays for the session the user signed out of.
  if (generation !== currentSessionGeneration() || sessionSaveInProgress()) {
    throw new Error(t("Could not clear the local session"));
  }
  // The local session clears first: a server that accepts the connection but never answers
  // must not keep this device signed in for the delivery's request timeout.
  const sessionCleared = await clearSessionToken();
  const spaceCleared = await clearSpace();
  if (!sessionCleared || !spaceCleared) throw new Error(t("Could not clear the local session"));
  // Delivery waits on the same silent server, so it cannot hold the visible sign-out either.
  // The persisted record covers an attempt that dies with the process.
  if (revocation.token) void deliverSignOutRecord(revocation, persisted);
}

export async function deleteAccount(password?: string, token?: string) {
  // No push unregistration: deleting the user removes the registrations on the server,
  // and unregistering first would silently end this device's notifications and calls
  // whenever the deletion is refused (wrong password, throttling, server error).
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
  // The server ended the session; the user never asked to leave. Keep the unsent
  // queue, so the app can report those messages before a sign-in deletes them.
  await clearSessionToken({ keepUnsent: true });
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
  const consentContext =
    options.requestContext ?? (uses.length ? await captureApiRequestContext() : undefined);
  for (const consentTarget of aiConsentTargets(body)) {
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
  }
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
      res = await fetchServer(
        `${consentContext?.apiBase ?? currentApiBase()}/rpc/${proc}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "rakazo://",
            ...requestHeaders,
            ...correlation,
          },
          body: JSON.stringify({ json: body }),
          signal: controller.signal,
        },
        consentContext?.apiBase ?? currentApiBase(),
      );
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
  | "threadStatus"
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
  | "dailyCheckIns"
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
  | "ticketBoardEnabled"
  | "botAvatarSet"
>;

export type MobileModel = ModelCatalogEntry;

/** Shared DTO includes headerNames only; header values remain in the server secret. */
export type MobileModelCredential = ModelCredential;

/** Live progress and streaming rows are shown before they have a seq, thread, or time. */
export type MobileMessage = LiveThreadMessage;

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
  run: LiveThreadRun | null;
  activeRuns?: LiveThreadRun[];
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

export function prependMobileMessagePage(
  prev: MobileSnapshot | null,
  page: MobileMessagePage,
): MobileSnapshot | null {
  return prependThreadHistoryPage(prev, page);
}

export { messagingProviderLabel };

export function blockText(message: MobileMessage) {
  return message.blocks
    .map((block) => {
      if (block.kind === "channel_message") return channelMessageLine(block);
      if (block.kind === "cloud_agent")
        return `${block.title}: ${block.status}${block.prUrl ? ` ${block.prUrl}` : ""}`;
      if (block.kind === "subagent") {
        return `${block.name ?? "subagent"}: ${block.result || block.progress || block.task || ""}`;
      }
      if (block.kind === "child_bot") {
        return `${block.status === "archived" ? "Archived" : block.status === "deleted" ? "Deleted" : "Bot"} ${block.name ?? ""}`;
      }
      if (block.kind === "chart") return `[chart: ${block.name ?? "chart"}]`;
      if (block.kind === "app") return `[app: ${block.server}]`;
      if (block.kind === "page") return `[page: ${block.title}]`;
      if (block.kind === "image") return `[image: ${block.name ?? "attachment"}]`;
      if (block.kind === "file") {
        return `[file: ${block.name ?? "attachment"}${block.size ? ` (${block.size} bytes)` : ""}]`;
      }
      if (block.kind === "steps") {
        return (block.steps ?? [])
          .map(
            (step) =>
              `${step.label}${step.detail ? `: ${step.detail}` : ""}${step.count > 1 ? ` ×${step.count}` : ""}`,
          )
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
  requestContext?: ApiRequestContext,
) {
  const context = requestContext ?? (await captureApiRequestContext());
  syncMobileAvatarSession(currentApiBase(), currentSessionGeneration());
  const activityFeed = beginMobileAvatarFeed(target, cursor);
  return subscribeRpcEvents(
    "threads/subscribe",
    { ...target, cursor },
    (event) => {
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
    },
    signal,
    context,
    () => mobileLogoAvatarActivity.resetSource(activityFeed.source),
  );
}

export async function subscribeIncomingCallEvents(
  onCalls: (calls: IncomingBotCall[]) => void,
  signal: AbortSignal,
) {
  const context = await captureApiRequestContext(null);
  return subscribeRpcEvents(
    "notifications/subscribeCalls",
    {},
    (event) => {
      if (event.type !== "incoming.calls") return;
      const calls = IncomingBotCallSchema.array().safeParse(event.payload?.calls);
      if (calls.success) onCalls(calls.data);
    },
    signal,
    context,
  );
}

async function subscribeRpcEvents(
  procedure: string,
  input: Record<string, unknown>,
  onEvent: (event: ThreadEvent) => void,
  signal: AbortSignal,
  context: ApiRequestContext,
  onClose: () => void = () => {},
) {
  const current = () =>
    context.apiBase === currentApiBase() &&
    context.sessionGeneration === currentSessionGeneration();
  if (!current()) {
    onClose();
    return;
  }
  const res = await fetchServer(
    `${context.apiBase}/rpc/${procedure}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        origin: "rakazo://",
        ...context.headers,
      },
      body: JSON.stringify({ json: input }),
      signal,
    },
    context.apiBase,
  ).catch((error: unknown) => {
    onClose();
    if (current() && !signal.aborted && isServerUnreachable(error)) noteServerReachable(false);
    throw error;
  });
  if (current()) noteServerReachable(!isUnreachableStatus(res.status));
  if (!res.ok || !res.body) {
    onClose();
    cancelResponseBody(res);
    throw httpError(`rpc ${procedure} failed (${res.status})`, res);
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
            onClose();
            return;
          }
          const event = parsed.json;
          onEvent(event);
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
    onClose();
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
