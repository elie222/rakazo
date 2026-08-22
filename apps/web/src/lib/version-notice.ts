import {
  type BuildIdentity,
  type ClientKind,
  describeVersionSkew,
  versionSkewNotice,
} from "@rakazo/core";

export type NoticeAction = "reload" | null;

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
}

/** Everything here is advisory: a build mismatch never blocks the app. */
export function resolveVersionNotice(input: NoticeInput): VersionNotice | null {
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
