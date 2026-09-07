import type { MessagingInboundMessage } from "@rakazo/adapter-kit";

/** Cap buffered TeamChat events while the bridge is still starting. */
export const PENDING_TEAM_CHAT_LIMIT = 100;

/** Bound how long shutdown waits for an in-flight TeamChatBridge.start(). */
export const TEAM_CHAT_STARTUP_SHUTDOWN_MS = 2_000;

/** Durable claim while wakeMessageRoutines may still be writing its wake nonce. */
export const MESSAGE_ROUTING_REASON = "message_routine_routing";
/** One-shot grace claim; a second expiry promotes to agent delivery. */
export const MESSAGE_ROUTING_REARMED_REASON = "message_routine_routing_rearmed";
/** Exclusive claim while TeamChat is creating the fallback agent run. */
export const TEAMCHAT_AGENT_OWNERSHIP_REASON = "message_teamchat_agent";
/** Hold deferred rows while a TeamChat wake may still create its run. */
export const MESSAGE_ROUTING_RESERVATION_MS = 30 * 60_000;

export function prefersTeamChatSurface(
  event: Pick<MessagingInboundMessage, "provider" | "workspaceId">,
  teamChatBotId: string | undefined | null,
): boolean {
  return (
    Boolean(teamChatBotId) &&
    (event.provider === "slack" ||
      event.provider === "teamchat-emulator" ||
      Boolean(event.workspaceId))
  );
}

/** Queue TeamChat-shaped messages until TeamChatBridge.receive is available. */
export class PendingTeamChatInbound {
  private readonly events: Array<{
    event: MessagingInboundMessage;
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];

  constructor(private readonly limit = PENDING_TEAM_CHAT_LIMIT) {}

  get size(): number {
    return this.events.length;
  }

  enqueue(event: MessagingInboundMessage): Promise<void> | null {
    if (this.events.length >= this.limit) return null;
    return new Promise<void>((resolve, reject) => {
      this.events.push({ event, resolve, reject });
    });
  }

  flush(handle: (event: MessagingInboundMessage) => Promise<void>): void {
    for (const pending of this.events.splice(0, this.events.length)) {
      void handle(pending.event).then(pending.resolve, pending.reject);
    }
  }

  reject(error: unknown): void {
    for (const pending of this.events.splice(0, this.events.length)) {
      pending.reject(error);
    }
  }
}

export function settleWithTimeout(
  task: Promise<unknown> | undefined,
  timeoutMs: number,
): Promise<"done" | "timeout"> {
  if (!task) return Promise.resolve("done");
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    task.then(
      () => "done" as const,
      () => "done" as const,
    ),
    new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
