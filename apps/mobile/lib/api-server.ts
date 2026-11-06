import * as SecureStore from "expo-secure-store";
import type { PendingSignOut } from "./api";
import {
  clearStoredValue,
  currentApiBase,
  currentSpaceSelectionGeneration,
  flushPendingSignOut,
  nextSpaceSelectionRequest,
  promotePendingSignOut,
  queueEndpointChange,
  rawSelectedSpaceId,
  removePendingSignOut,
  SPACE_KEY,
  SPACE_ROLLBACK_KEY,
  savePendingSignOut,
  selectedSpaceId,
  setCachedApiBase,
  setSelectedSpace,
  spaceSelectionSeq,
  writeStoredValue,
} from "./api";
import type { EndpointResult } from "./endpoint";
import { defaultApiBase, normalizeApiBase } from "./endpoint";
import { t } from "./i18n";
import { resumeLiveNotifications } from "./live-notifications";
import { API_BASE_STORAGE_KEY as ENDPOINT_KEY } from "./server-config";
import { loadServerHeaders, saveServerHeaders, serverHeaders } from "./server-headers";
import {
  clearSessionToken,
  currentSessionGeneration,
  loadSessionToken,
  restoreSessionToken,
  sessionSaveInProgress,
  snapshotSessionToken,
  snapshotStoredSessionToken,
} from "./session";

/** The Space last used in each organization on this device, by organization id. */
const ORGANIZATION_SPACES_KEY = "rakazo.org_spaces";
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
    setSelectedSpace(storedSpace);
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
  const requestGeneration = nextSpaceSelectionRequest();
  if (!(await clearStoredValue(SPACE_ROLLBACK_KEY))) return false;
  // Rollback cleanup is the first await. A newer selection may have claimed
  // the live space while this call was still deleting the rollback record.
  if (requestGeneration !== spaceSelectionSeq()) return false;
  // Claim memory before persisting: recovery paths reconcile against the
  // in-memory selection, so a durable write must never precede its owner.
  const previousSpaceId = rawSelectedSpaceId();
  setSelectedSpace(id);
  // Generation ownership distinguishes A→B→A from "we still own this claim":
  // an ID-only check would treat a later same-id selection as ours.
  const claimGeneration = currentSpaceSelectionGeneration();
  try {
    await SecureStore.setItemAsync(SPACE_KEY, id);
    // Our write may have landed stale behind a newer overlapping selection's
    // write. Re-assert the live selection best-effort so durable converges
    // to it; each selector heals at most once, so overlapping chains settle
    // on the latest claim. Never delete here: a missing memory owner means
    // another path (recovery, sign-out) owns cleanup.
    const liveSpaceId = rawSelectedSpaceId();
    if (liveSpaceId && liveSpaceId !== id) {
      await writeStoredValue(SPACE_KEY, liveSpaceId);
    }
  } catch {
    // Roll back the claim and heal durable state: a concurrent recovery may
    // have persisted the rolled-back id after reading it, which would leave
    // restart opening a Space the live session is not using. A newer
    // overlapping selection owns both by now, so only heal a claim we hold.
    if (rawSelectedSpaceId() === id && currentSpaceSelectionGeneration() === claimGeneration) {
      setSelectedSpace(previousSpaceId);
      const rollbackGeneration = currentSpaceSelectionGeneration();
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
    generation !== currentSpaceSelectionGeneration() ||
    sessionGeneration !== currentSessionGeneration() ||
    apiBase !== currentApiBase()
  )
    return;
  await resumeLiveNotifications(apiBase, token, id).catch(() => undefined);
}
/** Keep requests usable after the server deleted the selected Space but native
 * storage could not replace it. Neutralize any same-endpoint rollback before
 * writing the replacement selection so a cleanup failure cannot leave the new
 * id beside a stale record that recoverSpaceRollback would prefer on restart. */
/** The Space the user was actually on before a fallback adoption that has not
 * landed yet; a retry that persists must still count as leaving it. */
let pendingFallbackSwitchFrom: string | null = null;
export async function adoptDeletedSpaceFallback(id: string): Promise<boolean> {
  const previousSpaceId = rawSelectedSpaceId();
  if (pendingFallbackSwitchFrom === null && previousSpaceId !== id) {
    pendingFallbackSwitchFrom = previousSpaceId;
  }
  setSelectedSpace(id);
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
  setSelectedSpace("");
  return true;
}
async function snapshotSpace(): Promise<{ ok: true; value: string } | { ok: false }> {
  if (rawSelectedSpaceId()) return { ok: true, value: rawSelectedSpaceId() };
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
  const spaceGeneration = currentSpaceSelectionGeneration();
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
    if (previousSpace.value && currentSpaceSelectionGeneration() === spaceGeneration) {
      kept = await writeStoredValue(SPACE_KEY, previousSpace.value);
      // A selection made during a write may have landed first; store the live one again until a
      // write completes with no selection made during it.
      let written = spaceGeneration;
      while (currentSpaceSelectionGeneration() !== written) {
        written = currentSpaceSelectionGeneration();
        kept = rawSelectedSpaceId()
          ? await writeStoredValue(SPACE_KEY, rawSelectedSpaceId())
          : await clearStoredValue(SPACE_KEY);
      }
    }
    if (kept) await clearStoredValue(SPACE_ROLLBACK_KEY);
    return failed();
  }
  const sessionCleared = await clearSessionToken();
  setSelectedSpace("");
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
    setSelectedSpace(previousSpace);
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
  setSelectedSpace(rollback.spaceId);
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
