import type { RpcInput, RpcOutput, RpcPath, ThreadSnapshot } from "@rakazo/contracts";
import { CLIENT_UPDATE_REQUIRED_STATUS, parseServerHeaders } from "@rakazo/contracts";
import {
  aiConsentTargets,
  aiDataUsesForProcedure,
  cancelResponseBody,
  displayIdentityResult,
  ensureAiDataConsent,
  isServerUnreachable,
  isUnreachableStatus,
  parseRetryAfter,
  readBoundedJsonResponse,
  withAbort,
} from "@rakazo/core";
import { clientCorrelationHeaders, responseCorrelation } from "@rakazo/logging/monitoring";
import * as SecureStore from "expo-secure-store";
import { promptAiConsent } from "./ai-consent";
import type { EndpointResult } from "./endpoint";
import { defaultApiBase, normalizeApiBase } from "./endpoint";
import { t } from "./i18n";
import { identityLabels } from "./identity-display";
import {
  newMobileAvatarSnapshotRequest,
  rememberMobileAvatarSnapshot,
  syncMobileAvatarSession,
} from "./logo-avatar-activity";
import { reportMobileError } from "./monitoring";
import { followSelectedSpace, selectedSpaceChanged } from "./referral";
import { fetchServer } from "./server-headers";
import {
  clearSessionToken,
  currentSessionGeneration,
  loadSessionToken,
  saveVerifiedIntegrationsScope,
  sessionOnlyInMemory,
  sessionSaveInProgress,
  snapshotSessionToken,
} from "./session";
import { clearUnsentSends } from "./thread-feedback";
import { errorText } from "./user-error";

export const SPACE_KEY = "rakazo.space_id";
export const SPACE_ROLLBACK_KEY = "rakazo.space_rollback";
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
export function setCachedApiBase(url: string): void {
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
  for (const listener of [...spaceSelectionListeners]) listener();
}
const spaceSelectionListeners = new Set<() => void>();
/** Calls `listener` each time the selected Space changes. */
export function subscribeSelectedSpace(listener: () => void): () => void {
  spaceSelectionListeners.add(listener);
  return () => {
    spaceSelectionListeners.delete(listener);
  };
}
/** Orders complete endpoint transactions, including credential rollback. */
let endpointChangeQueue: Promise<unknown> = Promise.resolve();
/** Runs an endpoint change in order, holding the reconcile gate while it switches servers. */
export function queueEndpointChange(
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
export function noteServerReachable(reachable: boolean): void {
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
export function selectedSpaceId(): string | null {
  return cachedSpaceId || null;
}
export async function clearStoredValue(key: string): Promise<boolean> {
  try {
    await SecureStore.deleteItemAsync(key);
    return true;
  } catch {
    return writeStoredValue(key, "");
  }
}
export async function writeStoredValue(key: string, value: string): Promise<boolean> {
  try {
    await SecureStore.setItemAsync(key, value);
    return true;
  } catch {
    return false;
  }
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
  /** Native views can revoke a captured request before it reaches the network. */
  isCurrent?: () => boolean;
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
/** Revoking other sessions also refuses this one until the replacement is saved. */
let passwordChangesInFlight = 0;
export function passwordChangeInFlight() {
  return passwordChangesInFlight > 0;
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
export type PendingSignOut = {
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
export async function savePendingSignOut(record: PendingSignOut): Promise<boolean> {
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
export async function removePendingSignOut(record: PendingSignOut): Promise<void> {
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
export async function promotePendingSignOut(record: PendingSignOut): Promise<void> {
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
export function deliverSignOutRecord(record: PendingSignOut, persisted = true): Promise<void> {
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
  if (options.requestContext?.isCurrent?.() === false) throw new Error("Request canceled");
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
/**
 * A failed response as an error the shared retry policy can read: its status, oRPC code, and any
 * Retry-After. A 426 also asks the user to update, from whichever request noticed it.
 */
export function httpError(message: string, res: Response, code?: string): Error {
  if (res.status === CLIENT_UPDATE_REQUIRED_STATUS) clientBuild.onUpdateRequired();
  return Object.defineProperties(new Error(message), {
    status: { value: res.status },
    // oRPC's error code; a proxy's bare 404 has none.
    code: { value: code },
    retryAfterMs: { value: parseRetryAfter(res.headers.get("retry-after")) },
  });
}
/** Claims the in-memory Space selection ("" clears it) and starts a new selection epoch. */
export function setSelectedSpace(id: string): void {
  cachedSpaceId = id;
  bumpSpaceSelectionGeneration();
}

/** The in-memory selection as stored: "" when no Space is selected. */
export function rawSelectedSpaceId(): string {
  return cachedSpaceId;
}

/** Bumped on every in-memory Space selection change. */
export function currentSpaceSelectionGeneration(): number {
  return spaceSelectionGeneration;
}

/** Starts a selectSpace attempt; see spaceSelectionSeq. */
export function nextSpaceSelectionRequest(): number {
  return ++spaceSelectionRequestGeneration;
}

/** Marks a password change in flight; see passwordChangeInFlight. */
export function beginPasswordChange(): void {
  passwordChangesInFlight += 1;
}

export function endPasswordChange(): void {
  passwordChangesInFlight -= 1;
}
