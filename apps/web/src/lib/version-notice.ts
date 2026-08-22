import type { DesktopUpdateState } from "@rakazo/contracts";
import {
  type BuildIdentity,
  type ClientKind,
  describeVersionSkew,
  versionSkewNotice,
} from "@rakazo/core";

export type NoticeAction = "reload" | "download-desktop" | "install-desktop" | null;

export interface VersionNotice {
  /** Stable across renders so a dismissal sticks until the underlying situation changes. */
  key: string;
  title: string;
  detail: string;
  action: NoticeAction;
  actionLabel: string | null;
  busy: boolean;
}

export interface NoticeInput {
  client: BuildIdentity;
  clientKind: ClientKind;
  server: BuildIdentity | null;
  desktop: DesktopUpdateState | null;
}

/**
 * A ready desktop release outranks a version warning, because installing it is what resolves the
 * warning. Everything here is advisory: nothing returned by this function blocks the app.
 */
export function resolveVersionNotice(input: NoticeInput): VersionNotice | null {
  const desktop = input.desktop;
  if (desktop !== null && desktop.phase === "ready") {
    return {
      key: `desktop-ready:${desktop.availableVersion ?? ""}`,
      title: `Rakazo ${desktop.availableVersion ?? "update"} is ready`,
      detail: "Restart the app to finish installing. You can keep working until then.",
      action: "install-desktop",
      actionLabel: "Restart and install",
      busy: false,
    };
  }
  if (desktop !== null && desktop.phase === "downloading") {
    return {
      key: "desktop-downloading",
      title: `Downloading Rakazo ${desktop.availableVersion ?? "update"}`,
      detail: `${desktop.percent ?? 0}% complete. You can keep working while it downloads.`,
      action: null,
      actionLabel: null,
      busy: true,
    };
  }
  if (desktop !== null && desktop.phase === "available") {
    return {
      key: `desktop-available:${desktop.availableVersion ?? ""}`,
      title: `Rakazo ${desktop.availableVersion ?? "update"} is available`,
      detail: `This app is ${desktop.currentVersion}. Downloading the update keeps it in step with the servers you connect to.`,
      action: "download-desktop",
      actionLabel: "Download update",
      busy: false,
    };
  }

  if (input.server === null) return null;
  const skew = describeVersionSkew(input.client, input.server);
  const notice = versionSkewNotice(skew, input.clientKind);
  if (notice === null) return null;
  return {
    key: `skew:${skew.status}:${skew.serverVersion}:${skew.serverRevision ?? ""}`,
    title: notice.title,
    detail: notice.detail,
    action: notice.action === "reload" ? "reload" : null,
    actionLabel: notice.action === "reload" ? "Reload" : null,
    busy: false,
  };
}
