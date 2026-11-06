import { randomUUID } from "node:crypto";
import type { MessagingReceipt, MessagingSurface } from "@rakazo/adapter-kit";
import { clearTemporaryReceipt, providerOfThreadId } from "@rakazo/adapters";
import { getLogger } from "@rakazo/logging";

// A reaction stays on the message, so it only goes on a late one: a fast reply
// is its own acknowledgement.
const RECEIPT_DELAY_MS: Record<MessagingReceipt, number> = {
  typing: 0,
  reaction: 60_000,
};

const RECEIPT_TIMEOUT_MS = 2000;

/** Bound external cleanup and teardown even if their underlying operation stalls. */
async function within(operation: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Messaging receipt operation timed out")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface MessagingReceipts {
  acknowledge(threadId: string, handle: string, handled: () => Promise<boolean>): void;
  stop(): Promise<void>;
}

export function createMessagingReceipts(
  messaging: Pick<MessagingSurface, "platforms" | "acknowledge">,
): MessagingReceipts {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const cleanups = new Set<() => Promise<void>>();
  const pendingSends = new Set<Promise<void>>();
  let stopped = false;
  let stopping: Promise<void> | undefined;
  const logFailure = (error: unknown) => getLogger().error("messaging receipt error", error);

  const track = (cleanup: () => Promise<void>, handled: () => Promise<boolean>) => {
    let clearing: Promise<void> | undefined;
    let poll: ReturnType<typeof setTimeout> | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const cancel = (timer: ReturnType<typeof setTimeout> | undefined) => {
      if (timer) {
        clearTimeout(timer);
        timers.delete(timer);
      }
    };
    const clear = () => {
      clearing ??= (async () => {
        cancel(poll);
        cancel(expiry);
        try {
          await clearTemporaryReceipt(cleanup);
        } finally {
          cleanups.delete(clear);
        }
      })();
      return clearing;
    };
    cleanups.add(clear);
    const check = async () => {
      try {
        if (await handled()) {
          await clear();
          return;
        }
      } catch (error) {
        logFailure(error);
      }
      if (clearing || stopped) return;
      poll = setTimeout(() => {
        timers.delete(poll!);
        void check();
      }, 3_000);
      poll.unref?.();
      timers.add(poll);
    };
    if (stopped) {
      void clear();
      return;
    }
    // Expiry must not depend on a delivery query completing.
    expiry = setTimeout(() => {
      timers.delete(expiry!);
      void clear();
    }, 10 * 60_000);
    expiry.unref?.();
    timers.add(expiry);
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
  const launch = (operation: Promise<void>) => {
    const settled = operation.catch(logFailure);
    pendingSends.add(settled);
    void settled.then(() => pendingSends.delete(settled));
  };

  return {
    acknowledge(threadId, handle, handled) {
      if (stopped) return;
      const provider = providerOfThreadId(threadId);
      const receipt = messaging.platforms().find((platform) => platform.provider === provider)
        ?.capabilities.receipt;
      if (!receipt) return;
      const delay = RECEIPT_DELAY_MS[receipt];
      if (delay <= 0) {
        launch(send(threadId, handle, handled));
        return;
      }
      const timer = setTimeout(() => {
        timers.delete(timer);
        launch(
          (async () => {
            if ((await handled()) || stopped) return;
            await send(threadId, handle, handled);
          })(),
        );
      }, delay);
      timer.unref?.();
      timers.add(timer);
    },
    stop() {
      stopping ??= (async () => {
        stopped = true;
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        // Start existing deletions immediately, then include creates still on the wire.
        for (const cleanup of cleanups) void cleanup();
        await within(
          (async () => {
            await Promise.allSettled([...pendingSends]);
            await Promise.allSettled([...cleanups].map((cleanup) => cleanup()));
          })(),
          10_000,
        ).catch(logFailure);
      })();
      return stopping;
    },
  };
}
