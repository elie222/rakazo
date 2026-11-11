import type { IpcMainInvokeEvent } from "electron";
import type { AppTarget } from "./app-frame.js";
import { fromAppFrame } from "./app-frame.js";

/** The APNs environment a build's push entitlement names, from `RAKAZO_DESKTOP_PUSH`. */
export function desktopPushEnvironment(value: string | undefined) {
  return value === "production" || value === "development" ? value : undefined;
}

/**
 * Builds with `RAKAZO_DESKTOP_PUSH` set carry the push entitlement and the bundler inlines it, so
 * other builds never ask macOS for a token they cannot get.
 */
export const DESKTOP_PUSH_BUILD = Boolean(desktopPushEnvironment(process.env.RAKAZO_DESKTOP_PUSH));

/** The chat a notification click opened the app for. */
export type DesktopPushChat = {
  botId: string;
  threadId: string;
  spaceId?: string;
  groupId?: string;
};

const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);

/** Reads the chat from the `ready` event's launch info, when a notification opened the app. */
export function chatFromLaunch(launchInfo: unknown): DesktopPushChat | null {
  const userInfo =
    launchInfo && typeof launchInfo === "object" && "userInfo" in launchInfo
      ? (launchInfo as { userInfo?: unknown }).userInfo
      : undefined;
  if (!userInfo || typeof userInfo !== "object") return null;
  const data = userInfo as Record<string, unknown>;
  const botId = text(data.botId);
  const threadId = text(data.threadId);
  if (!botId || !threadId) return null;
  const spaceId = text(data.spaceId);
  const groupId = text(data.groupId);
  return { botId, threadId, ...(spaceId ? { spaceId } : {}), ...(groupId ? { groupId } : {}) };
}

/**
 * The app frame's view of push: the token to register with its server, and the chat a
 * notification click opened the app for, handed over once.
 */
export function createDesktopPush(options: {
  enabled: boolean;
  getTarget: () => AppTarget | null;
  register: () => Promise<string>;
}) {
  let token: Promise<string | null> | undefined;
  let opened: DesktopPushChat | null = null;
  const allowed = (event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">) =>
    options.enabled && fromAppFrame(options.getTarget(), event);
  return {
    launched(launchInfo: unknown) {
      opened = chatFromLaunch(launchInfo);
    },
    token(event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">): Promise<string | null> {
      if (!allowed(event)) return Promise.resolve(null);
      // A refusal (no entitlement, no network) is retried on the next page load.
      token ??= options.register().catch(() => {
        token = undefined;
        return null;
      });
      return token;
    },
    takeOpened(event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">) {
      if (!allowed(event)) return null;
      const chat = opened;
      opened = null;
      return chat;
    },
  };
}
