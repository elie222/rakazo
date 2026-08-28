import type { ProductEvent } from "@rakazo/contracts";
import { isRunTerminalEvent } from "@rakazo/core";
import { i18n } from "./i18n";

export type BrowserNotificationPermission = "default" | "denied" | "granted";

export type BrowserNotificationApi = {
  readonly permission: BrowserNotificationPermission;
  requestPermission(): Promise<BrowserNotificationPermission>;
};

let permissionRequest: Promise<BrowserNotificationPermission> | null = null;

export function requestBrowserNotificationPermission(
  api: BrowserNotificationApi | undefined = typeof Notification === "undefined"
    ? undefined
    : Notification,
): Promise<BrowserNotificationPermission> | undefined {
  if (!api) return undefined;
  if (api.permission !== "default") return Promise.resolve(api.permission);
  if (permissionRequest) return permissionRequest;
  try {
    permissionRequest = api.requestPermission().then(
      (permission) => {
        permissionRequest = null;
        return permission;
      },
      () => {
        permissionRequest = null;
        return api.permission;
      },
    );
  } catch {
    return Promise.resolve(api.permission);
  }
  return permissionRequest;
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

export function deliverBrowserRunNotification(
  event: Pick<ProductEvent, "type" | "runId">,
  botName: string,
  context: {
    enabled: boolean;
    pageVisible: boolean;
    windowFocused: boolean;
    permission: BrowserNotificationPermission;
    notifiedRunIds: Set<string>;
    show: (title: string, body: string) => void;
  },
): "delivered" | "pending" | "discarded" {
  const runId = event.runId;
  if (
    typeof runId !== "string" ||
    !context.enabled ||
    (context.pageVisible && context.windowFocused) ||
    context.notifiedRunIds.has(runId) ||
    context.permission === "denied"
  ) {
    return "discarded";
  }
  if (context.permission === "default") return "pending";
  const message = browserNotificationMessage(event, botName);
  try {
    context.show(message.title, message.body);
    context.notifiedRunIds.add(runId);
    return "delivered";
  } catch {
    return "pending";
  }
}
