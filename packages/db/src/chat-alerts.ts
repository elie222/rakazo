import type { RealtimeFanout } from "@rakazo/adapter-kit";
import type { ChatAlert } from "@rakazo/contracts";
import { ChatAlertSchema } from "@rakazo/contracts";

/** Transient: an alert published while the user has no app open is not replayed. */
export interface ChatAlerts {
  publish(userId: string, alert: ChatAlert): Promise<void>;
  follow(userId: string, signal?: AbortSignal): AsyncGenerator<ChatAlert>;
}

export function chatAlertTopic(userId: string): string {
  return `chat-alerts:${userId}`;
}

/**
 * Without a realtime fanout nothing is published and the stream stays open and empty. A failed
 * subscribe ends the stream with that error, so the app reconnects.
 */
export function createChatAlerts(realtime?: RealtimeFanout): ChatAlerts {
  return {
    async publish(userId, alert) {
      await realtime?.publish(chatAlertTopic(userId), JSON.stringify(alert));
    },
    async *follow(userId, signal) {
      const queue: ChatAlert[] = [];
      let wake: (() => void) | undefined;
      const unsubscribe = realtime
        ? await realtime
            .subscribe(chatAlertTopic(userId), (payload) => {
              let parsed: unknown;
              try {
                parsed = JSON.parse(payload);
              } catch {
                return;
              }
              const alert = ChatAlertSchema.safeParse(parsed);
              if (!alert.success) return;
              queue.push(alert.data);
              wake?.();
            })
        : async () => {};
      try {
        while (!signal?.aborted) {
          const next = queue.shift();
          if (next) {
            yield next;
            continue;
          }
          await new Promise<void>((resolve) => {
            const done = () => {
              wake = undefined;
              signal?.removeEventListener("abort", done);
              resolve();
            };
            wake = done;
            signal?.addEventListener("abort", done, { once: true });
            if (signal?.aborted) done();
          });
        }
      } finally {
        wake = undefined;
        await unsubscribe();
      }
    },
  };
}
