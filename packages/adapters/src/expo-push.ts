import { randomUUID } from "node:crypto";
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
import { combineSignals } from "./connector-safety.js";
import { credentialDigest } from "./credential-digest.js";
import type { PushTokenStore } from "./push-token-store.js";
import { readBodyCapped, withAbort } from "./web-ssrf.js";

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

/** Expiry stored for a registration's session; null while a replacement is pending. */
export type PushSessionExpiresAt = (sessionId: string) => Promise<Date | null>;

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
    private readonly tokens: PushTokenStore,
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
    const { status, body } = await this.postWithBackoff(EXPO_PUSH_URL, payload, context.signal);
    const [ticket] = expoPushTickets(body);
    if (status < 300 && body === undefined) {
      throw new Error("Expo push returned an invalid response.");
    }
    if (ticket?.details?.error === "DeviceNotRegistered") {
      await this.tokens.remove(context.userId, credentialDigest(token));
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

  /** Drops the token when the receipt says the device is no longer registered. */
  async checkReceipt(receipt: BackgroundJobPayloads["push.receipt"]): Promise<void> {
    const { status, body } = await this.postWithBackoff(EXPO_RECEIPTS_URL, {
      ids: [receipt.ticketId],
    });
    // The next send's ticket also reports an unregistered device, so a skipped check loses nothing.
    if (expoAskedToBackOff(status, body)) {
      getLogger().warn("expo push receipt unavailable", { status });
      return;
    }
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
      await this.tokens.remove(receipt.userId, receipt.tokenDigest);
      return;
    }
    getLogger().error(
      `expo push receipt error: ${result.details?.error ?? result.message ?? "unknown"}`,
    );
  }

  private async postWithBackoff(url: string, payload: unknown, signal?: AbortSignal) {
    for (let attempt = 0; ; attempt += 1) {
      const reply = await postToExpo(url, payload, this.accessToken, signal);
      const retryDelay = this.retryDelaysMs[attempt];
      if (retryDelay === undefined || !expoAskedToBackOff(reply.status, reply.body)) return reply;
      await delay(retryDelay, undefined, { signal });
    }
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
    const saved = await this.tokens.load(userId);
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
      await this.tokens.endSession(userId, saved.sessionId);
      return undefined;
    }
    const current = await this.tokens.load(userId);
    if (current?.token !== saved.token || current.sessionId !== saved.sessionId) return undefined;
    return current.token;
  }
}

export type ExpoPushDelivery = "delivered" | "undeliverable";

function expoAskedToBackOff(status: number, body: unknown): boolean {
  return (
    status === 429 ||
    status >= 500 ||
    expoPushTickets(body)[0]?.details?.error === "MessageRateExceeded"
  );
}

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
    getLogger().warn("expo push request failed", { error });
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
