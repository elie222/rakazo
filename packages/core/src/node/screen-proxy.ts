import { createDecipheriv, createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

const SENSITIVE_FORWARD_HEADERS = new Set([
  "authorization",
  "cookie",
  "host",
  "proxy-authenticate",
  "proxy-authorization",
]);
const SENSITIVE_RESPONSE_HEADERS = new Set(["clear-site-data", "set-cookie", "set-cookie2"]);
const SCREEN_PROXY_CIPHER = "aes-256-gcm";

export function resolveNovncTarget(url: string | undefined, secret: string, now = Date.now()) {
  const match = url?.match(
    /^\/novnc\/([A-Za-z0-9_-]+)\/(\d+)\/(view|control)\/(\d+)\.([A-Za-z0-9_-]{43})(\/[^?]*)?(\?.*)?$/,
  );
  if (match) return resolveLocalTarget(match, secret, now);

  const remoteMatch = url?.match(
    /^\/novnc\/remote\/(view|control)\/(\d+)\.([A-Za-z0-9_-]+)(\/[^?]*)?(\?.*)?$/,
  );
  if (!remoteMatch) return null;
  const policy = remoteMatch[1]! as "view" | "control";
  const expiresAt = Number(remoteMatch[2]);
  if (!Number.isInteger(expiresAt) || expiresAt < now) return null;
  const target = openScreenTarget(remoteMatch[3]!, secret, policy, expiresAt);
  if (target?.protocol !== "https:") return null;
  const requestedPath = `${remoteMatch[4] || target.pathname || "/"}${remoteMatch[5] || ""}`;
  return {
    protocol: target.protocol,
    hostname: target.hostname,
    port: Number(target.port || 443),
    path: screenPolicyPath(remoteTargetPath(target, requestedPath), policy === "control"),
    interactive: policy === "control",
  };
}

function resolveLocalTarget(match: RegExpMatchArray, secret: string, now: number) {
  const hostname = Buffer.from(match[1]!, "base64url").toString("utf8");
  const port = Number(match[2]);
  const policy = match[3]! as "view" | "control";
  const expiresAt = Number(match[4]);
  const signature = match[5]!;
  const requestedPath = `${match[6] || "/"}${match[7] || ""}`;
  if (!isAllowedTargetName(hostname)) return null;
  if (!Number.isInteger(port) || port < 1024 || port > 65_535 || expiresAt < now) return null;
  const expected = createHmac("sha256", secret)
    .update(`${hostname}:${port}:${policy}:${expiresAt}`)
    .digest("base64url");
  const suppliedBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (
    suppliedBytes.length !== expectedBytes.length ||
    !timingSafeEqual(suppliedBytes, expectedBytes)
  ) {
    return null;
  }
  return {
    hostname,
    port,
    path: screenPolicyPath(requestedPath, policy === "control"),
    interactive: policy === "control",
  };
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
  if (path === target.pathname || path === "/websockify") {
    return `${path}${target.search}`;
  }
  return `${path}${requested.search}`;
}

function openScreenTarget(
  token: string,
  secret: string,
  policy: "view" | "control",
  expiresAt: number,
) {
  try {
    const sealed = Buffer.from(token, "base64url");
    if (sealed.length <= 28) return null;
    const decipher = createDecipheriv(
      SCREEN_PROXY_CIPHER,
      createHash("sha256").update(secret).digest(),
      sealed.subarray(0, 12),
    );
    decipher.setAAD(Buffer.from(`${policy}:${expiresAt}`));
    decipher.setAuthTag(sealed.subarray(12, 28));
    const target = new URL(
      Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]).toString("utf8"),
    );
    return target.hostname && target.protocol === "https:" ? target : null;
  } catch {
    return null;
  }
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

function isHttp2PseudoHeader(key: string) {
  return key.startsWith(":");
}

export function safeProxyHeaders(headers: IncomingHttpHeaders) {
  return Object.fromEntries(
    Object.entries(headers).filter(([key, value]) => {
      return (
        value != null &&
        !isHttp2PseudoHeader(key) &&
        !SENSITIVE_FORWARD_HEADERS.has(key.toLowerCase())
      );
    }),
  );
}

export function safeProxyResponseHeaders(headers: IncomingHttpHeaders) {
  return Object.fromEntries(
    Object.entries(headers).filter(([key, value]) => {
      return (
        value != null &&
        !isHttp2PseudoHeader(key) &&
        !SENSITIVE_RESPONSE_HEADERS.has(key.toLowerCase())
      );
    }),
  );
}

export function stripSensitiveHandshakeHeaders(response: Buffer) {
  const end = response.indexOf("\r\n\r\n");
  if (end < 0) return null;
  const lines = response.subarray(0, end).toString("latin1").split("\r\n");
  const safeLines = lines.filter((line, index) => {
    if (index === 0) return true;
    const separator = line.indexOf(":");
    const name = separator < 0 ? line : line.slice(0, separator);
    return !SENSITIVE_RESPONSE_HEADERS.has(name.trim().toLowerCase());
  });
  return Buffer.concat([
    Buffer.from(`${safeLines.join("\r\n")}\r\n\r\n`, "latin1"),
    response.subarray(end + 4),
  ]);
}
