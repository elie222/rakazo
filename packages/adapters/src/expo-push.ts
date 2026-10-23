import { randomUUID } from "node:crypto";
import { closeSync, constants, openSync } from "node:fs";
import { mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  AdapterContext,
  BackgroundJobPayloads,
  JobPublisher,
  NotificationMessage,
  NotificationProvider,
} from "@rakazo/adapter-kit";
import { pushReceiptJob } from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import koffi from "koffi";
import { combineSignals } from "./connector-safety.js";
import { credentialDigest } from "./credential-digest.js";
import { readBodyCapped, withAbort } from "./web-ssrf.js";

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
const EXPO_PUSH_TIMEOUT_MS = 15_000;
/** Expo asks for exponential backoff on 429, 5xx and `MessageRateExceeded`. */
const EXPO_PUSH_RETRY_DELAYS_MS = [1_000, 2_000];
/** Expo suggests reading receipts 15 minutes after a send and clears them after a day. */
const EXPO_RECEIPT_DELAY_MS = 15 * 60_000;
/** Keeps a push well inside Expo's 4096-byte payload limit. */
const MAX_PUSH_TITLE_CHARS = 100;
const MAX_PUSH_BODY_CHARS = 180;
export const MAX_EXPO_PUSH_RESPONSE_BYTES = 64 * 1024;
const RESPONSE_TOO_LARGE = "Expo push response is too large.";

/** Data a notification tap uses to open the bot or group thread in its space.
 * `deliveryId` distinguishes this send from another push for the same thread:
 * the Expo request identifier stays the thread id. */
export function expoPushData(message: NotificationMessage, spaceId: string, deliveryId: string) {
  return {
    kind: message.kind,
    botId: message.botId,
    threadId: message.threadId,
    deliveryId,
    ...(spaceId ? { spaceId } : {}),
    ...(message.groupId ? { groupId: message.groupId } : {}),
  };
}

export function pushTokenPath(dataDir: string, userId: string) {
  return path.join(dataDir, "push-tokens", `${userId}.txt`);
}

type PushRecord = { token: string; sessionId?: string };

const PUSH_TOKEN_LOCK_WAIT_MS = 15_000;

/** Registration found that its session was already gone. */
export class PushSessionEndedError extends Error {
  constructor() {
    super("Push session ended");
    this.name = "PushSessionEndedError";
  }
}

/** Expiry of the session that registered a token, or null when that session is gone. */
export type PushSessionExpiresAt = (sessionId: string) => Promise<Date | null>;

export async function loadPushToken(dataDir: string, userId: string): Promise<string | undefined> {
  return (await readPushToken(dataDir, userId))?.token;
}

/** The file holds the token, then the id of the session that registered it. */
async function readPushToken(dataDir: string, userId: string): Promise<PushRecord | undefined> {
  try {
    const handle = await open(pushTokenPath(dataDir, userId), constants.O_RDONLY | O_NOFOLLOW);
    try {
      const [token, sessionId] = (await handle.readFile("utf8")).trim().split("\n");
      return token ? { token, sessionId: sessionId || undefined } : undefined;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

type SavePushTokenOptions = {
  /** Checked under the token lock, before the token is published. */
  sessionActive?: () => Promise<boolean>;
  /** Runs under the lock after other owners are read and before they are removed. */
  beforeRemoveOthers?: () => Promise<void>;
};

type EndSessionPushTokenOptions = {
  /** Runs after this account's record is read and before the conditional update. */
  beforeCommit?: () => Promise<void>;
};

/**
 * A device token belongs to one account: saving it removes it from every other
 * user, so a handed-over device stops receiving the previous account's pushes.
 * The session check and the write are one locked step.
 */
export async function savePushToken(
  dataDir: string,
  userId: string,
  token: string,
  sessionId?: string,
  options?: SavePushTokenOptions,
): Promise<void> {
  const value = token.trim();
  await withPushTokenLock(dataDir, async () => {
    if (options?.sessionActive && !(await options.sessionActive())) {
      throw new PushSessionEndedError();
    }
    await writePushTokenFile(dataDir, userId, { token: value, sessionId });
    const dir = path.dirname(pushTokenPath(dataDir, userId));
    const claimed: Array<{ userId: string; record: PushRecord }> = [];
    for (const name of await readdir(dir)) {
      const otherUserId = path.basename(name, ".txt");
      if (!name.endsWith(".txt") || otherUserId === userId) continue;
      const current = await readPushToken(dataDir, otherUserId);
      if (current?.token === value) claimed.push({ userId: otherUserId, record: current });
    }
    await options?.beforeRemoveOthers?.();
    for (const other of claimed) {
      await compareAndSwapPushToken(dataDir, other.userId, other.record, undefined);
    }
  });
}

export async function deletePushToken(dataDir: string, userId: string): Promise<void> {
  await withPushTokenLock(dataDir, async () => {
    await unlinkOwnedPushToken(dataDir, userId);
  });
}

/** Removes a token Expo reported unregistered, unless the device has since registered another. */
async function deleteUnregisteredPushToken(
  dataDir: string,
  userId: string,
  tokenDigest: string,
): Promise<void> {
  await withPushTokenLock(dataDir, async () => {
    const current = await readPushToken(dataDir, userId);
    if (!current || credentialDigest(current.token) !== tokenDigest) return;
    await compareAndSwapPushToken(dataDir, userId, current, undefined);
  });
}

/**
 * Ends the token registered by a session that is gone. The update lands only
 * when the file still holds that session, so a replacement cannot reclaim a
 * token another account has taken.
 */
export async function endSessionPushToken(
  dataDir: string,
  userId: string,
  sessionId: string,
  nextSessionId?: string,
  options?: EndSessionPushTokenOptions,
): Promise<void> {
  await withPushTokenLock(dataDir, async () => {
    const expected = await readPushToken(dataDir, userId);
    if (expected?.sessionId !== sessionId) return;
    await options?.beforeCommit?.();
    await compareAndSwapPushToken(
      dataDir,
      userId,
      expected,
      nextSessionId ? { token: expected.token, sessionId: nextSessionId } : undefined,
    );
  });
}

function samePushRecord(left: PushRecord | undefined, right: PushRecord | undefined): boolean {
  if (!left || !right) return !left && !right;
  return left.token === right.token && left.sessionId === right.sessionId;
}

/** Writes `next` only when the file still equals `expected`. Callers hold the token lock. */
async function compareAndSwapPushToken(
  dataDir: string,
  userId: string,
  expected: PushRecord | undefined,
  next: PushRecord | undefined,
): Promise<boolean> {
  const current = await readPushToken(dataDir, userId);
  if (!samePushRecord(current, expected)) return false;
  if (!next) {
    await unlinkOwnedPushToken(dataDir, userId);
    return true;
  }
  await writePushTokenFile(dataDir, userId, next);
  return true;
}

async function unlinkOwnedPushToken(dataDir: string, userId: string): Promise<void> {
  await unlink(pushTokenPath(dataDir, userId)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function writePushTokenFile(
  dataDir: string,
  userId: string,
  record: PushRecord,
): Promise<void> {
  const file = pushTokenPath(dataDir, userId);
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });
  // Renamed into place, so a concurrent read sees the old or the new token, never an empty file.
  const staging = path.join(dir, `.${userId}.${randomUUID()}.tmp`);
  const handle = await open(
    staging,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.chmod(0o600);
    const body = record.sessionId ? `${record.token}\n${record.sessionId}` : record.token;
    await handle.writeFile(body, "utf8");
  } finally {
    await handle.close();
  }
  await rename(staging, file).catch(async (error: unknown) => {
    await unlink(staging).catch(() => undefined);
    throw error;
  });
}

/**
 * API and worker are separate processes, sometimes separate containers, sharing
 * this directory. The lock is the kernel lock on `.lock`: the same file on a
 * shared volume, released when the holder exits, including a crash. An empty
 * lock file is not itself the lock.
 */
async function withPushTokenLock<T>(dataDir: string, body: () => Promise<T>): Promise<T> {
  const release = await acquirePushTokenLock(dataDir);
  try {
    return await body();
  } finally {
    await release();
  }
}

async function acquirePushTokenLock(dataDir: string): Promise<() => Promise<void>> {
  const dir = path.join(dataDir, "push-tokens");
  await mkdir(dir, { recursive: true });
  const lockFile = path.join(dir, ".lock");
  const fd = openSync(lockFile, constants.O_CREAT | constants.O_RDWR | O_NOFOLLOW, 0o600);
  try {
    await waitForExclusiveLock(fd);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return async () => {
    try {
      unlockExclusive(fd);
    } finally {
      closeSync(fd);
    }
  };
}

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const LOCKFILE_FAIL_IMMEDIATELY = 0x00000001;
const LOCKFILE_EXCLUSIVE_LOCK = 0x00000002;
const ERROR_LOCK_VIOLATION = 33;

type PosixFlock = (fd: number, operation: number) => number;

let posixFlock: PosixFlock | undefined;

function loadPosixFlock(): PosixFlock {
  posixFlock ??= koffi
    .load(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : null)
    .func("int flock(int fd, int operation)") as PosixFlock;
  return posixFlock;
}

type WindowsFileLock = {
  osfhandle: (fd: number) => number | bigint;
  LockFileEx: (
    handle: number | bigint,
    flags: number,
    reserved: number,
    bytesLow: number,
    bytesHigh: number,
    overlapped: Buffer,
  ) => number;
  UnlockFileEx: (
    handle: number | bigint,
    reserved: number,
    bytesLow: number,
    bytesHigh: number,
    overlapped: Buffer,
  ) => number;
  GetLastError: () => number;
};

let windowsFileLock: WindowsFileLock | undefined;

function loadWindowsFileLock(): WindowsFileLock {
  if (windowsFileLock) return windowsFileLock;
  const kernel32 = koffi.load("kernel32.dll");
  windowsFileLock = {
    // Node's descriptor table, not a separately loaded C runtime.
    osfhandle: koffi.load(null).func("intptr_t __cdecl uv_get_osfhandle(int fd)") as (
      fd: number,
    ) => number | bigint,
    LockFileEx: kernel32.func(
      "int __stdcall LockFileEx(void *hFile, uint32_t dwFlags, uint32_t dwReserved, uint32_t nNumberOfBytesToLockLow, uint32_t nNumberOfBytesToLockHigh, void *lpOverlapped)",
    ) as WindowsFileLock["LockFileEx"],
    UnlockFileEx: kernel32.func(
      "int __stdcall UnlockFileEx(void *hFile, uint32_t dwReserved, uint32_t nNumberOfBytesToLockLow, uint32_t nNumberOfBytesToLockHigh, void *lpOverlapped)",
    ) as WindowsFileLock["UnlockFileEx"],
    GetLastError: kernel32.func("uint32_t __stdcall GetLastError()") as () => number,
  };
  return windowsFileLock;
}

function tryExclusiveLock(fd: number): boolean {
  if (process.platform === "win32") {
    const bindings = loadWindowsFileLock();
    const handle = bindings.osfhandle(fd);
    if (handle === 0 || handle === -1 || handle === -1n) {
      throw new Error("Push token lock handle is invalid.");
    }
    const overlapped = Buffer.alloc(32);
    if (
      bindings.LockFileEx(
        handle,
        LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
        0,
        1,
        0,
        overlapped,
      )
    ) {
      return true;
    }
    if (Number(bindings.GetLastError()) === ERROR_LOCK_VIOLATION) return false;
    throw new Error("Push token lock failed.");
  }
  return loadPosixFlock()(fd, LOCK_EX | LOCK_NB) === 0;
}

function unlockExclusive(fd: number): void {
  if (process.platform === "win32") {
    const bindings = loadWindowsFileLock();
    const handle = bindings.osfhandle(fd);
    bindings.UnlockFileEx(handle, 0, 1, 0, Buffer.alloc(32));
    return;
  }
  loadPosixFlock()(fd, LOCK_UN);
}

async function waitForExclusiveLock(fd: number): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (tryExclusiveLock(fd)) return;
    if (Date.now() - started > PUSH_TOKEN_LOCK_WAIT_MS) {
      throw new Error("Push token update timed out.");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export type ExpoPushTicket = {
  status?: string;
  id?: string;
  message?: string;
  details?: { error?: string };
};

export function expoPushTickets(body: unknown): ExpoPushTicket[] {
  if (!body || typeof body !== "object") return [];
  const data = (body as { data?: unknown }).data;
  if (Array.isArray(data)) {
    return data.filter((item): item is ExpoPushTicket => Boolean(item) && typeof item === "object");
  }
  if (data && typeof data === "object") return [data as ExpoPushTicket];
  return [];
}

export function expoPushErrorMessage(body: unknown, status: number): string | undefined {
  const failed = expoPushTickets(body).filter((ticket) => ticket.status === "error");
  if (!expoRequestErrors(body) && failed.length > 0) {
    return failed
      .map((ticket) => ticket.message ?? ticket.details?.error ?? "expo push ticket error")
      .join("; ");
  }
  return expoRequestError(body, status);
}

type ExpoRequestError = { code?: string; message?: string };

function expoRequestErrorList(body: unknown): ExpoRequestError[] {
  if (!body || typeof body !== "object" || !("errors" in body)) return [];
  const errors = (body as { errors?: unknown }).errors;
  return Array.isArray(errors) ? (errors as ExpoRequestError[]) : [];
}

function expoRequestErrors(body: unknown): string | undefined {
  const errors = expoRequestErrorList(body);
  if (errors.length === 0) return undefined;
  return errors.map((error) => error.message ?? "expo push error").join("; ");
}

/**
 * A project with enhanced push security rejects requests without a valid
 * access token. Names the setting and never echoes the token.
 */
function expoUnauthorizedError(
  body: unknown,
  status: number,
  accessToken: string | undefined,
): string | undefined {
  const unauthorized =
    status === 401 || expoRequestErrorList(body).some((error) => error.code === "UNAUTHORIZED");
  if (!unauthorized) return undefined;
  return accessToken
    ? "Expo rejected EXPO_ACCESS_TOKEN; it may be revoked or belong to another project."
    : "Expo requires an access token for this project; set EXPO_ACCESS_TOKEN.";
}

/** A failure of the whole request, as opposed to one ticket or receipt. */
function expoRequestError(body: unknown, status: number, accessToken?: string): string | undefined {
  const unauthorized = expoUnauthorizedError(body, status, accessToken);
  if (unauthorized) return unauthorized;
  const errors = expoRequestErrors(body);
  if (errors) return errors;
  if (status < 200 || status >= 300) return `expo push failed (${status})`;
  return undefined;
}

function expoPushReceipts(body: unknown): Record<string, ExpoPushTicket | undefined> {
  const data = body && typeof body === "object" ? (body as { data?: unknown }).data : undefined;
  return data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, ExpoPushTicket>)
    : {};
}

export type ExpoPushOptions = {
  sessionExpiresAt?: PushSessionExpiresAt;
  /** Schedules the receipt check; without it receipts are not read. */
  jobs?: JobPublisher;
  /** Sent as a bearer token when the Expo project enforces enhanced push security. */
  accessToken?: string;
  retryDelaysMs?: readonly number[];
};

export class ExpoPushProvider implements NotificationProvider {
  private readonly sessionExpiresAt?: PushSessionExpiresAt;
  private readonly jobs?: JobPublisher;
  private readonly accessToken?: string;
  private readonly retryDelaysMs: readonly number[];

  constructor(
    private readonly dataDir: string,
    options: ExpoPushOptions = {},
  ) {
    this.sessionExpiresAt = options.sessionExpiresAt;
    this.jobs = options.jobs;
    this.accessToken = options.accessToken?.trim() || undefined;
    this.retryDelaysMs = options.retryDelaysMs ?? EXPO_PUSH_RETRY_DELAYS_MS;
  }

  describe() {
    return {
      id: "expo-push",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { push: true, email: false },
    };
  }

  async hasPushRecipient(userId: string): Promise<boolean> {
    return Boolean(await this.deliverableToken(userId));
  }

  async send(message: NotificationMessage, context: AdapterContext): Promise<void> {
    await this.deliver(message, context);
  }

  /**
   * Posts the push when a token is registered. `undeliverable` means this user
   * has no token, or Expo said the device is gone and the token was dropped.
   * Neither is an Expo acceptance, so callers must not record a reminder.
   */
  async deliver(message: NotificationMessage, context: AdapterContext): Promise<ExpoPushDelivery> {
    const token = await this.deliverableToken(context.userId);
    if (!token) return "undeliverable";
    const payload = {
      to: token,
      title: capped(message.title, MAX_PUSH_TITLE_CHARS),
      body: capped(message.body, MAX_PUSH_BODY_CHARS),
      collapseId: message.threadId,
      tag: message.threadId,
      ...(message.badge === undefined ? {} : { badge: message.badge }),
      data: expoPushData(message, context.spaceId, randomUUID()),
    };
    for (let attempt = 0; ; attempt += 1) {
      const { status, body } = await postToExpo(
        EXPO_PUSH_URL,
        payload,
        this.accessToken,
        context.signal,
      );
      const [ticket] = expoPushTickets(body);
      const retryDelay = this.retryDelaysMs[attempt];
      if (
        retryDelay !== undefined &&
        (status === 429 || status >= 500 || ticket?.details?.error === "MessageRateExceeded")
      ) {
        await delay(retryDelay, undefined, { signal: context.signal });
        continue;
      }
      if (status < 300 && body === undefined) {
        throw new Error("Expo push returned an invalid response.");
      }
      if (ticket?.details?.error === "DeviceNotRegistered") {
        await deleteUnregisteredPushToken(this.dataDir, context.userId, credentialDigest(token));
        return "undeliverable";
      }
      const failure =
        expoUnauthorizedError(body, status, this.accessToken) ?? expoPushErrorMessage(body, status);
      if (failure) {
        getLogger().error(failure);
        throw new Error(failure);
      }
      if (ticket?.id) await this.scheduleReceiptCheck(context.userId, token, ticket.id);
      return "delivered";
    }
  }

  /** Drops the token when the receipt says the device is no longer registered. */
  async checkReceipt(receipt: BackgroundJobPayloads["push.receipt"]): Promise<void> {
    const { status, body } = await postToExpo(
      EXPO_RECEIPTS_URL,
      { ids: [receipt.ticketId] },
      this.accessToken,
    );
    const failure = expoRequestError(body, status, this.accessToken);
    if (failure) throw new Error(failure);
    const result = expoPushReceipts(body)[receipt.ticketId];
    // Still missing 15 minutes on means Expo lost it; there is nothing left to check.
    if (!result) {
      getLogger().warn("expo push receipt missing");
      return;
    }
    if (result.status !== "error") return;
    if (result.details?.error === "DeviceNotRegistered") {
      await deleteUnregisteredPushToken(this.dataDir, receipt.userId, receipt.tokenDigest);
      return;
    }
    getLogger().error(
      `expo push receipt error: ${result.details?.error ?? result.message ?? "unknown"}`,
    );
  }

  private async scheduleReceiptCheck(userId: string, token: string, ticketId: string) {
    if (!this.jobs) return;
    await this.jobs
      .enqueue(
        pushReceiptJob(
          { userId, ticketId, tokenDigest: credentialDigest(token) },
          new Date(Date.now() + EXPO_RECEIPT_DELAY_MS),
        ),
      )
      .catch((error) => getLogger().error("expo push receipt enqueue", error));
  }

  /**
   * A token bound to a session is delivered only while that session is still
   * live. A missing row is left for session replacement to retarget; an expired
   * row is removed. The token is read again after the lookup so a handover
   * during that wait is not sent.
   */
  private async deliverableToken(userId: string): Promise<string | undefined> {
    const saved = await readPushToken(this.dataDir, userId);
    if (!saved?.token) return undefined;
    if (!saved.sessionId) return saved.token;
    if (!this.sessionExpiresAt) return undefined;
    let expiresAt: Date | null;
    try {
      expiresAt = await this.sessionExpiresAt(saved.sessionId);
    } catch (error) {
      getLogger().error("push session lookup failed", error);
      return undefined;
    }
    if (!expiresAt) return undefined;
    if (expiresAt.getTime() <= Date.now()) {
      await endSessionPushToken(this.dataDir, userId, saved.sessionId);
      return undefined;
    }
    const current = await readPushToken(this.dataDir, userId);
    if (current?.token !== saved.token || current.sessionId !== saved.sessionId) return undefined;
    return current.token;
  }
}

export type ExpoPushDelivery = "delivered" | "undeliverable";

/**
 * One POST to Expo. A network failure, while sending or reading the reply,
 * reads as a 503 so the caller retries it like one.
 */
async function postToExpo(
  url: string,
  payload: unknown,
  accessToken: string | undefined,
  signal?: AbortSignal,
): Promise<{ status: number; body: unknown }> {
  const attempt = combineSignals(signal, AbortSignal.timeout(EXPO_PUSH_TIMEOUT_MS));
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: attempt,
    });
    return { status: response.status, body: await readExpoPushBody(response, attempt) };
  } catch (error) {
    getLogger().error("expo push request failed", error);
    if (signal?.aborted || errorMessage(error) === RESPONSE_TOO_LARGE) throw error;
    return { status: 503, body: { errors: [{ message: errorMessage(error) }] } };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function capped(text: string, maxChars: number): string {
  const chars = Array.from(text);
  return chars.length <= maxChars ? text : `${chars.slice(0, maxChars - 1).join("")}…`;
}

async function readExpoPushBody(response: Response, signal: AbortSignal): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_EXPO_PUSH_RESPONSE_BYTES) {
    const cancel = response.body?.cancel() ?? Promise.resolve();
    await withAbort(
      cancel.catch(() => undefined),
      signal,
    ).catch(() => undefined);
    throw new Error(RESPONSE_TOO_LARGE);
  }
  try {
    const bytes = await readBodyCapped(response, MAX_EXPO_PUSH_RESPONSE_BYTES, signal);
    if (bytes.byteLength === 0) return undefined;
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    if (error instanceof Error && error.message === "Response is too large") {
      throw new Error(RESPONSE_TOO_LARGE);
    }
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}
