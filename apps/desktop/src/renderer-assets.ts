import path from "node:path";

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
