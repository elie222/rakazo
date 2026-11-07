import { COMPUTER_SCREEN_PATH } from "@rakazo/contracts/content-security-policy";
import { secureHttpOrigin as httpOrigin } from "@rakazo/contracts/network-host";
import type { Session, WebContents } from "electron";

type AppPermissionTarget = {
  webContents: WebContents;
  url: string;
};

/** Install before loading any content, including setup, storage probes and OAuth popups. */
export function installSessionPermissions(
  targetSession: Session,
  getApp: () => AppPermissionTarget | null,
) {
  function currentApp() {
    const app = getApp();
    if (!app || app.webContents.isDestroyed() || app.webContents.session !== targetSession) {
      return null;
    }
    const origin = httpOrigin(app.url);
    if (origin === null || httpOrigin(app.webContents.getURL()) !== origin) return null;
    return { ...app, origin };
  }

  targetSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const app = currentApp();
    if (permission === "clipboard-read" && app && contents === app.webContents) {
      // Electron asks for read access when the bot's screen copies to the host clipboard.
      callback(!details.isMainFrame && isScreenFrame(details.requestingUrl, app.origin));
      return;
    }
    if (
      !app ||
      contents !== app.webContents ||
      !details.isMainFrame ||
      httpOrigin(details.requestingUrl) !== app.origin
    ) {
      callback(false);
      return;
    }

    if (permission === "media") {
      // Dictation needs only the microphone. OS consent still applies after this grant.
      callback(
        "securityOrigin" in details &&
          httpOrigin(details.securityOrigin) === app.origin &&
          "mediaTypes" in details &&
          (details.mediaTypes?.length ?? 0) > 0 &&
          details.mediaTypes?.every((type) => type === "audio") === true,
      );
      return;
    }
    callback(permission === "notifications" || permission === "clipboard-sanitized-write");
  });

  targetSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    const app = currentApp();
    if (!app || httpOrigin(requestingOrigin) !== app.origin) return false;
    if (
      (details.embeddingOrigin !== undefined &&
        httpOrigin(details.embeddingOrigin) !== app.origin) ||
      (details.securityOrigin !== undefined && httpOrigin(details.securityOrigin) !== app.origin)
    ) {
      return false;
    }

    // Electron can check notifications without a WebContents. Require both origins;
    // never extend this origin-only exception to capture, clipboard or other permissions.
    if (contents === null) {
      return permission === "notifications" && httpOrigin(details.embeddingOrigin) === app.origin;
    }
    if (
      contents !== app.webContents ||
      !details.isMainFrame ||
      httpOrigin(details.requestingUrl) !== app.origin
    ) {
      return false;
    }

    if (permission === "media") return details.mediaType === "audio";
    return permission === "notifications" || permission === "clipboard-sanitized-write";
  });
}

/** The app's own computer screen, which syncs its clipboard with the host's. */
function isScreenFrame(url: string, origin: string) {
  if (httpOrigin(url) !== origin) return false;
  const { pathname } = new URL(url);
  return pathname.startsWith("/novnc/") || pathname === COMPUTER_SCREEN_PATH;
}
