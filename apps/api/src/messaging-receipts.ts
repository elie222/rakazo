import { randomUUID } from "node:crypto";
import type { MessagingReceipt, MessagingSurface } from "@rakazo/adapter-kit";
import { providerOfThreadId } from "@rakazo/adapters";
import { getLogger } from "@rakazo/logging";

// A reaction stays on the message, so it only goes on a late one: a fast reply
// is its own acknowledgement.
const RECEIPT_DELAY_MS: Record<MessagingReceipt, number> = {
  typing: 0,
  reaction: 60_000,
};

const RECEIPT_TIMEOUT_MS = 2000;

export interface MessagingReceipts {
  acknowledge(threadId: string, handle: string, handled: () => Promise<boolean>): void;
  stop(): void;
}

export function createMessagingReceipts(
  messaging: Pick<MessagingSurface, "platforms" | "acknowledge">,
): MessagingReceipts {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const cleanups = new Set<() => Promise<void>>();
  let stopped = false;

  const track = (cleanup: () => Promise<void>, handled: () => Promise<boolean>) => {
    const deadline = Date.now() + 10 * 60_000;
    const clear = async () => {
      if (!cleanups.delete(clear)) return;
      await cleanup();
    };
    cleanups.add(clear);
    const check = async () => {
      try {
        if (stopped || Date.now() >= deadline || (await handled())) {
          await clear();
          return;
        }
      } catch (error) {
        logFailure(error);
      }
      if (!cleanups.has(clear)) return;
      const timer = setTimeout(() => {
        timers.delete(timer);
        void check();
      }, 3_000);
      timer.unref?.();
      timers.add(timer);
    };
    void check();
  };

  const send = async (
    threadId: string,
    handle: string,
    handled: () => Promise<boolean>,
  ): Promise<void> => {
    const operationId = `messaging.acknowledge:${randomUUID()}`;
    const cleanup = await messaging.acknowledge(threadId, handle, {
      operationId,
      traceId: operationId,
      spaceId: "",
      userId: "",
      signal: AbortSignal.timeout(RECEIPT_TIMEOUT_MS),
    });
    if (cleanup) track(cleanup, handled);
  };
  const logFailure = (error: unknown) => getLogger().error("messaging receipt error", error);

  return {
    acknowledge(threadId, handle, handled) {
      if (stopped) return;
      const provider = providerOfThreadId(threadId);
      const receipt = messaging.platforms().find((platform) => platform.provider === provider)
        ?.capabilities.receipt;
      if (!receipt) return;
      const delay = RECEIPT_DELAY_MS[receipt];
      if (delay <= 0) {
        send(threadId, handle, handled).catch(logFailure);
        return;
      }
      const timer = setTimeout(() => {
        timers.delete(timer);
        (async () => {
          if ((await handled()) || stopped) return;
          await send(threadId, handle, handled);
        })().catch(logFailure);
      }, delay);
      timer.unref?.();
      timers.add(timer);
    },
    stop() {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const cleanup of cleanups) void cleanup().catch(logFailure);
    },
  };
}
