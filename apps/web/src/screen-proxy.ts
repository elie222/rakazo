import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

const SENSITIVE_FORWARD_HEADERS = new Set([
  "authorization",
  "cookie",
  "host",
  "proxy-authenticate",
  "proxy-authorization",
]);
const SENSITIVE_RESPONSE_HEADERS = new Set(["clear-site-data", "set-cookie", "set-cookie2"]);

export function resolveNovncTarget(url: string | undefined, secret: string, now = Date.now()) {
  const match = url?.match(
    /^\/novnc\/([A-Za-z0-9_-]+)\/(\d+)\/(view|control)\/(\d+)\.([A-Za-z0-9_-]{43})(\/[^?]*)?(\?.*)?$/,
  );
  if (!match) return null;
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
  if (parsed.pathname === "/embed.html") {
    return `/embed.html?view_only=${interactive ? "false" : "true"}`;
  }
  return parsed.pathname;
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

export function safeProxyHeaders(headers: IncomingHttpHeaders) {
  return Object.fromEntries(
    Object.entries(headers).filter(([key, value]) => {
      return value != null && !SENSITIVE_FORWARD_HEADERS.has(key.toLowerCase());
    }),
  );
}

export function safeProxyResponseHeaders(headers: IncomingHttpHeaders) {
  return Object.fromEntries(
    Object.entries(headers).filter(([key, value]) => {
      return value != null && !SENSITIVE_RESPONSE_HEADERS.has(key.toLowerCase());
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
