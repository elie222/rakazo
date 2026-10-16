import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { Hono } from "hono";

/**
 * The mobile app draws a chat diagram in a WebView that loads Mermaid from the server it already
 * talks to, so the app ships without a copy and no third-party CDN sees the request.
 */
export const DIAGRAM_SCRIPT_PATH = "/api/v1/assets/mermaid.js";

const require = createRequire(import.meta.url);

type DiagramScript = { body: Uint8Array<ArrayBuffer>; etag: string };

let script: Promise<DiagramScript> | undefined;

function loadDiagramScript(): Promise<DiagramScript> {
  script ??= (async () => {
    const { version } = require("mermaid/package.json") as { version: string };
    const file = await readFile(require.resolve("mermaid/dist/mermaid.min.js"));
    return { body: new Uint8Array(file), etag: `"mermaid-${version}"` };
  })().catch((error: unknown) => {
    script = undefined;
    throw error;
  });
  return script;
}

export function mountDiagramScript(app: Hono) {
  app.get(DIAGRAM_SCRIPT_PATH, async (c) => {
    const { body, etag } = await loadDiagramScript();
    // Public and the same for every caller: the file only changes with the Mermaid version.
    const headers = {
      "cache-control": "public, max-age=86400",
      etag,
      "x-content-type-options": "nosniff",
    };
    const ifNoneMatch = c.req.header("if-none-match") ?? "";
    // Match quoted tags as a whole: commas inside an opaque tag are not list separators.
    const tags = [...ifNoneMatch.matchAll(/(?:^|,)\s*(?:W\/)?("[^"]*")\s*(?=,|$)/g)];
    if (ifNoneMatch.trim() === "*" || tags.some(([, tag]) => tag === etag)) {
      return c.body(null, 304, headers);
    }
    return c.body(body, 200, { ...headers, "content-type": "text/javascript; charset=utf-8" });
  });
}
