import type { ProductEvent } from "@rakazo/contracts";
import { isRunTerminalEvent } from "@rakazo/core";

export type BrowserNotificationPermission = "default" | "denied" | "granted";

export type BrowserNotificationContext = {
  subscribedThreadId: string;
  initialCursor: number;
  streamReady: boolean;
  pageVisible: boolean;
  windowFocused: boolean;
  permission: BrowserNotificationPermission;
  notifiedRunIds: ReadonlySet<string>;
};

export function shouldNotifyBrowser(
  event: Pick<ProductEvent, "type" | "threadId" | "runId" | "seq">,
  context: BrowserNotificationContext,
): boolean {
  return (
    context.streamReady &&
    isRunTerminalEvent(event) &&
    event.threadId === context.subscribedThreadId &&
    event.seq > context.initialCursor &&
    (!context.pageVisible || !context.windowFocused) &&
    context.permission === "granted" &&
    typeof event.runId === "string" &&
    !context.notifiedRunIds.has(event.runId)
  );
}

export function browserNotificationMessage(
  event: Pick<ProductEvent, "type">,
  botName: string,
): { title: string; body: string } {
  const name = botName.trim() || "Bot";
  if (event.type === "run.failed") {
    return { title: `${name} failed`, body: "Your bot run failed." };
  }
  if (event.type === "run.cancelled") {
    return { title: `${name} stopped`, body: "Your bot run was stopped." };
  }
  return { title: `${name} finished`, body: "Your bot finished its work." };
}
