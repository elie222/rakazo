import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const SCREEN_PROXY_TTL_MS = 60 * 60_000;
export const SCREEN_TARGET_ENDPOINT = "/api/internal/screen-target";
export const SCREEN_RECHECK_MS = 1_000;

export interface ScreenCapabilityScope {
  botId: string;
  computerId: string;
  botGeneration: number;
  computerGeneration: number;
  controlLeaseId: string | null;
}

export interface ScreenProxyTarget {
  protocol: "http:" | "https:";
  hostname: string;
  port: number;
  path: string;
  interactive: boolean;
}

export function isScreenProxyTarget(value: unknown): value is ScreenProxyTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as Record<string, unknown>;
  return (
    (target.protocol === "http:" || target.protocol === "https:") &&
    typeof target.hostname === "string" &&
    target.hostname.length > 0 &&
    !/[\s/]/.test(target.hostname) &&
    typeof target.port === "number" &&
    Number.isInteger(target.port) &&
    target.port > 0 &&
    target.port <= 65535 &&
    typeof target.path === "string" &&
    target.path.startsWith("/") &&
    !/[\r\n]/.test(target.path) &&
    typeof target.interactive === "boolean"
  );
}

export function sealScreenCapability(
  url: string,
  secret: string,
  origin: string,
  scope: ScreenCapabilityScope,
  now = Date.now(),
) {
  const target = new URL(url);
  if (target.protocol !== "https:" && target.protocol !== "http:")
    throw new Error("Invalid screen protocol");
  const policy = target.searchParams.get("view_only") === "false" ? "control" : "view";
  const expiresAt = now + SCREEN_PROXY_TTL_MS;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), iv, {
    authTagLength: 16,
  });
  cipher.setAAD(Buffer.from(`${policy}:${expiresAt}`));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({ url, scope }), "utf8"),
    cipher.final(),
  ]);
  const token = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
  const prefix = `/novnc/session/${policy}/${expiresAt}.${token}`;
  const result = new URL(`${prefix}${target.pathname || "/"}`, new URL(origin).origin);
  // noVNC reads these from the browser URL. Keep its socket inside the capability
  // route while the provider's nested socket token stays sealed server-side.
  result.search = new URLSearchParams({
    autoconnect: "true",
    resize: "scale",
    view_only: policy === "control" ? "false" : "true",
    // Our embed resolves the socket relative to its own capability directory;
    // stock noVNC resolves it from the origin root.
    path: target.pathname === "/embed.html" ? "websockify" : `${prefix.slice(1)}/websockify`,
  }).toString();
  return result.toString();
}

export function openScreenCapability(
  path: string | undefined,
  secret: string,
  now = Date.now(),
): { scope: ScreenCapabilityScope; expiresAt: number; target: ScreenProxyTarget } | null {
  const match = path?.match(
    /^\/novnc\/session\/(view|control)\/(\d+)\.([A-Za-z0-9_-]+)(\/[^?]*)?(\?.*)?$/,
  );
  if (!match) return null;
  const expiresAt = Number(match[2]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return null;
  try {
    const sealed = Buffer.from(match[3]!, "base64url");
    if (sealed.length < 28) return null;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      createHash("sha256").update(secret).digest(),
      sealed.subarray(0, 12),
      { authTagLength: 16 },
    );
    decipher.setAAD(Buffer.from(`${match[1]}:${expiresAt}`));
    decipher.setAuthTag(sealed.subarray(12, 28));
    const payload = JSON.parse(
      Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]).toString("utf8"),
    );
    const scope = payload.scope as ScreenCapabilityScope;
    if (
      !scope ||
      typeof scope.botId !== "string" ||
      typeof scope.computerId !== "string" ||
      !Number.isSafeInteger(scope.botGeneration) ||
      !Number.isSafeInteger(scope.computerGeneration) ||
      (scope.controlLeaseId !== null && typeof scope.controlLeaseId !== "string")
    )
      return null;
    const target = new URL(payload.url);
    if (target.protocol !== "https:" && target.protocol !== "http:") return null;
    const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
    if (
      target.protocol === "http:" &&
      (!isAllowedTargetName(target.hostname) || port < 1024 || port > 65535)
    )
      return null;
    const interactive = match[1] === "control";
    const requestedPath = `${match[4] || target.pathname || "/"}${match[5] || ""}`;
    return {
      scope,
      expiresAt,
      target: {
        protocol: target.protocol,
        hostname: target.hostname,
        port,
        path: screenPolicyPath(remoteTargetPath(target, requestedPath), interactive),
        interactive,
      },
    };
  } catch {
    return null;
  }
}

export function screenPolicyPath(requestedPath: string, interactive: boolean) {
  const parsed = new URL(requestedPath, "http://screen.invalid");
  if (parsed.pathname === "/embed.html" || parsed.pathname === "/vnc.html") {
    parsed.searchParams.set("view_only", interactive ? "false" : "true");
  }
  return `${parsed.pathname}${parsed.search}`;
}

function remoteTargetPath(target: URL, requestedPath: string) {
  const requested = new URL(requestedPath, "https://screen.invalid");
  const path = requested.pathname || target.pathname || "/";
  if (path === "/websockify" && target.searchParams.has("path")) {
    const socket = new URL(target.searchParams.get("path")!, target);
    return `${socket.pathname}${socket.search}`;
  }
  if (path === target.pathname || path === "/websockify") {
    return `${path}${target.search}`;
  }
  return `${path}${requested.search}`;
}

function isAllowedTargetName(hostname: string) {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    /^10\.(?:\d{1,3}\.){2}\d{1,3}$/.test(hostname) ||
    /^172\.(?:1[6-9]|2\d|3[01])\.(?:\d{1,3})\.\d{1,3}$/.test(hostname) ||
    /^192\.168\.(?:\d{1,3})\.\d{1,3}$/.test(hostname) ||
    /^rakazo-bot-[a-zA-Z0-9_.-]+$/.test(hostname)
  );
}
