export interface BuildIdentity {
  version: string;
  revision?: string | null;
}

export type SkewStatus = "match" | "client-behind" | "client-ahead" | "build-differs" | "unknown";

/** `browser` reloads to pick up the server's assets; `desktop` ships its own installed build. */
export type ClientKind = "browser" | "desktop";

export interface VersionSkew {
  status: SkewStatus;
  clientVersion: string;
  serverVersion: string;
  clientRevision: string | null;
  serverRevision: string | null;
}

const NUMERIC = /^\d+$/;

/** Compares the release part of two semver strings; prerelease and build metadata are ignored. */
export function compareVersions(a: string, b: string): number {
  const left = releaseParts(a);
  const right = releaseParts(b);
  if (left === null || right === null) return 0;
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

function releaseParts(value: string): number[] | null {
  const release = value.trim().replace(/^v/, "").split(/[-+]/, 1)[0] ?? "";
  const parts = release.split(".");
  if (parts.length === 0 || parts.length > 3) return null;
  if (!parts.every((part) => NUMERIC.test(part))) return null;
  return parts.map((part) => Number(part));
}

export function isComparableVersion(value: string): boolean {
  return releaseParts(value) !== null;
}

/**
 * Prefers the release version because that is what a separately installed desktop build can be
 * ranked by. The commit only decides the tie, which is the common case in this repo where every
 * package sits on the same version between releases.
 */
export function describeVersionSkew(client: BuildIdentity, server: BuildIdentity): VersionSkew {
  const clientRevision = normalizeRevision(client.revision);
  const serverRevision = normalizeRevision(server.revision);
  const base = {
    clientVersion: client.version,
    serverVersion: server.version,
    clientRevision,
    serverRevision,
  };
  if (!isComparableVersion(client.version) || !isComparableVersion(server.version)) {
    return { ...base, status: "unknown" };
  }
  const order = compareVersions(client.version, server.version);
  if (order < 0) return { ...base, status: "client-behind" };
  if (order > 0) return { ...base, status: "client-ahead" };
  if (clientRevision !== null && serverRevision !== null && clientRevision !== serverRevision) {
    return { ...base, status: "build-differs" };
  }
  return { ...base, status: "match" };
}

function normalizeRevision(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

export interface SkewNotice {
  title: string;
  detail: string;
  /** `reload` is only ever offered to a browser, which gets its assets from the server. */
  action: "reload" | "update-desktop" | "update-server" | null;
}

export function versionSkewNotice(skew: VersionSkew, client: ClientKind): SkewNotice | null {
  if (skew.status === "match" || skew.status === "unknown") return null;

  if (client === "browser") {
    return {
      title: "This tab is running an older build",
      detail: `The server is on ${describeBuild(skew.serverVersion, skew.serverRevision)} and this tab loaded ${describeBuild(skew.clientVersion, skew.clientRevision)}. Reload to pick up the matching app. Everything keeps working until you do.`,
      action: "reload",
    };
  }

  if (skew.status === "client-behind") {
    return {
      title: "The desktop app is behind this server",
      detail: `This app is ${skew.clientVersion} and the server is ${skew.serverVersion}. Install the latest Rakazo desktop update to match. You can keep working in the meantime.`,
      action: "update-desktop",
    };
  }
  if (skew.status === "client-ahead") {
    return {
      title: "This server is behind the desktop app",
      detail: `This app is ${skew.clientVersion} and the server is ${skew.serverVersion}. Ask the deployment owner to update the server. You can keep working in the meantime.`,
      action: "update-server",
    };
  }
  return {
    title: "The desktop app and server were built from different commits",
    detail: `This app is on ${describeBuild(skew.clientVersion, skew.clientRevision)} and the server is on ${describeBuild(skew.serverVersion, skew.serverRevision)}. Update whichever side is older. You can keep working in the meantime.`,
    action: null,
  };
}

function describeBuild(version: string, revision: string | null): string {
  return revision === null ? version : `${version} (${revision.slice(0, 7)})`;
}
