import type { ProductEvent } from "@rakazo/contracts";
import { isRunTerminalEvent } from "@rakazo/core";
import { i18n } from "./i18n";

export type BrowserNotificationPermission = "default" | "denied" | "granted";

export type BrowserNotificationApi = {
  readonly permission: BrowserNotificationPermission;
  requestPermission(): Promise<BrowserNotificationPermission>;
};

let permissionRequestPending = false;

export function requestBrowserNotificationPermission(
  api: BrowserNotificationApi | undefined = typeof Notification === "undefined"
    ? undefined
    : Notification,
): void {
  if (permissionRequestPending || !api || api.permission !== "default") return;
  permissionRequestPending = true;
  const clearPending = () => {
    permissionRequestPending = false;
  };
  try {
    void api.requestPermission().then(clearPending, clearPending);
  } catch {
    clearPending();
  }
}

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
  const name = botName.trim() || i18n._({ id: "Bot", message: "Bot" });
  if (event.type === "run.failed") {
    return {
      title: i18n._({ id: "{name} failed", message: "{name} failed", values: { name } }),
      body: i18n._({ id: "Failed.", message: "Failed." }),
    };
  }
  if (event.type === "run.cancelled") {
    return {
      title: i18n._({ id: "{name} stopped", message: "{name} stopped", values: { name } }),
      body: i18n._({ id: "Stopped.", message: "Stopped." }),
    };
  }
  return {
    title: i18n._({ id: "{name} finished", message: "{name} finished", values: { name } }),
    body: i18n._({ id: "Finished.", message: "Finished." }),
  };
}
