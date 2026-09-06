import type { Session, WebContents } from "electron";
import { isLoopbackHost } from "./setup-config.js";

type AppPermissionTarget = {
  webContents: WebContents;
  url: string;
};

function httpOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    // LAN HTTP remains a supported server target, but cannot safely receive host permissions.
    return url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname))
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

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
