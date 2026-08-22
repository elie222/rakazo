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
const VERSION =
  /^v?(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:\.(0|[1-9]\d*))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Semver ordering with optional minor/patch shorthand; build metadata does not affect precedence. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) return 0;
  for (let index = 0; index < 3; index += 1) {
    const leftPart = left.release[index] ?? 0n;
    const rightPart = right.release[index] ?? 0n;
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) {
      if (leftPart === rightPart) return 0;
      return leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) continue;
    const leftNumeric = NUMERIC.test(leftPart);
    const rightNumeric = NUMERIC.test(rightPart);
    if (leftNumeric && rightNumeric) return BigInt(leftPart) < BigInt(rightPart) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function parseVersion(
  value: string,
): { release: [bigint, bigint, bigint]; prerelease: string[] } | null {
  const match = VERSION.exec(value.trim());
  if (!match) return null;
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((part) => NUMERIC.test(part) && part.length > 1 && part.startsWith("0"))) {
    return null;
  }
  return {
    release: [BigInt(match[1] ?? "0"), BigInt(match[2] ?? "0"), BigInt(match[3] ?? "0")],
    prerelease,
  };
}

export function isComparableVersion(value: string): boolean {
  return parseVersion(value) !== null;
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
      title: "This tab and server are on different builds",
      detail: `The server is on ${describeBuild(skew.serverVersion, skew.serverRevision)} and this tab loaded ${describeBuild(skew.clientVersion, skew.clientRevision)}. Reload once to pick up the current web app. If this notice remains, the deployment is still finishing its update. Everything keeps working until then.`,
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
