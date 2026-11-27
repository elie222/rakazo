import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The address link crawlers reach the app at, from `RAKAZO_HOST`. A loopback host has none,
 * since no crawler can reach it, and a public host is served over TLS.
 */
export function publicOrigin(host: string | undefined): string | undefined {
  if (!host) return undefined;
  const url = new URL(`https://${host}`);
  return LOOPBACK_HOSTS.has(url.hostname) ? undefined : url.origin;
}

/** Link previews ignore a relative image, so the page names its preview image in full. */
export function withAbsoluteSocialImage(html: string, origin: string): string {
  return html.replaceAll('content="/og-image.png"', `content="${origin}/og-image.png"`);
}

/**
 * The built page, rewritten once, for `vite preview`. Runs after Vite's SPA fallback has
 * rewritten the request to `/index.html`, so it answers exactly the requests that get the app.
 */
export function indexPageMiddleware(outDir: string, rewrite: (html: string) => string) {
  const html = rewrite(readFileSync(path.join(outDir, "index.html"), "utf8"));
  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (req.url?.split("?", 1)[0] !== "/index.html" || req.headers["sec-fetch-dest"] === "script") {
      return next();
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "no-cache");
    res.end(req.method === "HEAD" ? undefined : html);
  };
}
