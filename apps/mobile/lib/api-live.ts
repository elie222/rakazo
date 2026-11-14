import type { IncomingBotCall } from "@rakazo/contracts";
import { IncomingBotCallSchema } from "@rakazo/contracts";
import {
  cancelResponseBody,
  displayIdentityEvent,
  isServerUnreachable,
  isUnreachableStatus,
} from "@rakazo/core";
import type { ApiRequestContext } from "./api";
import {
  captureApiRequestContext,
  currentApiBase,
  httpError,
  MAX_MOBILE_RPC_RESPONSE_BYTES,
  noteServerReachable,
} from "./api";
import { identityLabels } from "./identity-display";
import {
  beginMobileAvatarFeed,
  mobileLogoAvatarActivity,
  syncMobileAvatarSession,
} from "./logo-avatar-activity";
import { fetchServer } from "./server-headers";
import { currentSessionGeneration } from "./session";

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
/**
 * Calls `onSignal` for each roster signal and `onComputerUpdates` for each computer update signal:
 * each once when the stream opens, then once per change.
 */
export async function subscribeRosterSignals(
  onSignal: () => void,
  signal: AbortSignal,
  onComputerUpdates: () => void = () => {},
) {
  const context = await captureApiRequestContext();
  return subscribeRpcEvents(
    "notifications/subscribe",
    {},
    (event) => {
      if (event.type === "roster") onSignal();
      else if (event.type === "computerUpdates") onComputerUpdates();
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
