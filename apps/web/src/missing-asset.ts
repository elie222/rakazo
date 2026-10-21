import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

/**
 * A tab from an older deploy asks for hashed chunks this build no longer has. Answer 404 instead
 * of the SPA's index.html, which the browser would otherwise try to run as a script.
 */
export function missingAssetMiddleware(
  assetsDir: string,
  urlPrefix: string,
  exists: (file: string) => boolean = existsSync,
) {
  const root = path.resolve(assetsDir);
  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const pathname = req.url?.split("?", 1)[0] ?? "/";
    if (!pathname.startsWith(urlPrefix)) {
      next();
      return;
    }
    let file = "";
    try {
      file = path.resolve(root, decodeURIComponent(pathname.slice(urlPrefix.length)));
    } catch {
      // A malformed escape is never a real asset.
    }
    if (file.startsWith(root + path.sep) && exists(file)) {
      next();
      return;
    }
    res.statusCode = 404;
    res.setHeader("cache-control", "no-store");
    res.end("Not found");
  };
}
