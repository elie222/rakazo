import path from "node:path";
import {
  CSP_REPORTING_ENDPOINTS,
  contentSecurityPolicyFor,
} from "@rakazo/contracts/content-security-policy";

const PASSTHROUGH_PATHS = ["/api", "/rpc", "/novnc"];

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function bundledRendererCandidates(
  root: string,
  requestUrl: string,
  webOrigin: string,
  acceptsHtml: boolean,
) {
  const url = new URL(requestUrl);
  if (
    url.origin !== webOrigin ||
    PASSTHROUGH_PATHS.some((prefix) => matchesPrefix(url.pathname, prefix))
  ) {
    return null;
  }

  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (pathname.includes("\0")) return null;

  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const candidate = safeChild(root, requested);
  if (!candidate) return null;
  return acceptsHtml ? [candidate, path.join(root, "index.html")] : [candidate];
}

export function contentType(file: string) {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

export function immutableRendererAsset(file: string) {
  return path.basename(path.dirname(file)) === "assets";
}

/** The headers the web server would send, including its CSP, since this replaces that server. */
export function bundledRendererHeaders(file: string, requestUrl: string): Headers {
  const headers = new Headers({
    "cache-control": immutableRendererAsset(file)
      ? "public, max-age=31536000, immutable"
      : "no-cache",
    "content-type": contentType(file),
    "x-content-type-options": "nosniff",
  });
  const policy = contentSecurityPolicyFor(new URL(requestUrl).pathname);
  if (policy) {
    headers.set("content-security-policy", policy);
    // Reports go to /api on this origin, which is forwarded to the API like every other call.
    headers.set("reporting-endpoints", CSP_REPORTING_ENDPOINTS);
  }
  return headers;
}

export function isRendererAssetMiss(error: unknown) {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR";
}

export function forwardedRendererRequestInit(request: Request, webOrigin: string) {
  const init: RequestInit & { bypassCustomProtocolHandlers: boolean } = {
    bypassCustomProtocolHandlers: true,
    credentials: "include",
  };
  if (new URL(request.url).origin !== webOrigin) return init;
  const headers = new Headers(request.headers);
  headers.set("origin", webOrigin);
  return { ...init, headers };
}

function matchesPrefix(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function safeChild(root: string, requested: string) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, requested);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return resolved;
}
