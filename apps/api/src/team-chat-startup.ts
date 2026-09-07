import type { MessagingInboundMessage } from "@rakazo/adapter-kit";

/** Cap buffered TeamChat events while the bridge is still starting. */
export const PENDING_TEAM_CHAT_LIMIT = 100;

/** Bound how long shutdown waits for an in-flight TeamChatBridge.start(). */
export const TEAM_CHAT_STARTUP_SHUTDOWN_MS = 2_000;

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
  private readonly events: MessagingInboundMessage[] = [];

  constructor(private readonly limit = PENDING_TEAM_CHAT_LIMIT) {}

  get size(): number {
    return this.events.length;
  }

  enqueue(event: MessagingInboundMessage): boolean {
    if (this.events.length >= this.limit) return false;
    this.events.push(event);
    return true;
  }

  drain(): MessagingInboundMessage[] {
    return this.events.splice(0, this.events.length);
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
