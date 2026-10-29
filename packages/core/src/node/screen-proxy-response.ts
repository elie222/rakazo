import type { IncomingHttpHeaders } from "node:http";

const SENSITIVE_RESPONSE_HEADERS = new Set(["clear-site-data", "set-cookie", "set-cookie2"]);
const SCREEN_SANDBOX = "sandbox allow-scripts allow-pointer-lock";

/** Screen listeners are untrusted even when their capability URL is opened outside an iframe. */
export function safeScreenProxyResponseHeaders(
  headers: IncomingHttpHeaders,
  requestOrigin?: string,
) {
  const safe: IncomingHttpHeaders = {};
  const policies: string[] = [];
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase();
    if (value == null || name.startsWith(":") || SENSITIVE_RESPONSE_HEADERS.has(name)) continue;
    if (name === "content-security-policy") {
      policies.push(...(Array.isArray(value) ? value : [value]));
    } else {
      safe[name] = value;
    }
  }
  // Separate CSP policies intersect. An upstream allow-same-origin cannot relax this sandbox,
  // and existing provider restrictions (including frame-ancestors) remain in force.
  safe["content-security-policy"] = [...policies, SCREEN_SANDBOX];
  // Module imports from the opaque sandbox origin still need access to noVNC assets. The page
  // imports them with credentials, so an access proxy's cookie in front of Rakazo comes along;
  // that needs the exact origin, which for the sandbox is "null".
  if (requestOrigin === "null") {
    safe["access-control-allow-origin"] = "null";
    safe["access-control-allow-credentials"] = "true";
    safe.vary = "Origin";
  } else {
    safe["access-control-allow-origin"] = "*";
  }
  // A CDN in front of the web service must pass the screen through untouched: injected scripts,
  // minification and script loaders break noVNC's module scripts.
  const cacheControl = safe["cache-control"];
  safe["cache-control"] = [
    ...(Array.isArray(cacheControl) ? cacheControl : [cacheControl]),
    "no-transform",
  ]
    .filter(Boolean)
    .join(", ");
  return safe;
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
