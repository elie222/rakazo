import { app, pushNotifications } from "electron";
import { handleIpc } from "../ipc/ipc.js";
import type { AppTarget } from "../windows/app-frame.js";
import { createDesktopPush, DESKTOP_PUSH_BUILD } from "./desktop-push.js";

/**
 * Notifications while the app is closed. Called before `ready`, which carries the notification a
 * click launched the app from; the function it returns answers the page once IPC is set up.
 */
export function installDesktopPush(getTarget: () => AppTarget | null) {
  const desktopPush = createDesktopPush({
    enabled: process.platform === "darwin" && DESKTOP_PUSH_BUILD,
    getTarget,
    register: () => pushNotifications.registerForAPNSNotifications(),
  });
  app.once("ready", (_event, launchInfo) => desktopPush.launched(launchInfo));
  return () => {
    handleIpc("desktop.push.token", (event) => desktopPush.token(event));
    handleIpc("desktop.push.takeOpened", (event) => desktopPush.takeOpened(event));
  };
}
