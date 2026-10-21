import type { IncomingHttpHeaders } from "node:http";
import type { Readable } from "node:stream";

export const MAX_NOVNC_HTML_BYTES = 1024 * 1024;

const NOVNC_PAGES = new Set(["vnc.html", "vnc_lite.html", "embed.html"]);

/** Whether an upstream path is a noVNC page, whichever provider serves it. */
export function isNovncPage(path: string) {
  const { pathname } = new URL(path, "http://upstream.invalid");
  return NOVNC_PAGES.has(pathname.slice(pathname.lastIndexOf("/") + 1));
}

/**
 * The proxy sandboxes screen documents without same-origin, so noVNC's settings reads from
 * localStorage throw. Only uncompressed HTML for a noVNC page is rewritten.
 */
export function shouldInjectNovncStorageShim(headers: IncomingHttpHeaders, path: string) {
  if (!isNovncPage(path)) return false;
  const encoding = String(headers["content-encoding"] ?? "")
    .trim()
    .toLowerCase();
  if (encoding && encoding !== "identity") return false;
  const contentType = String(headers["content-type"] ?? "").toLowerCase();
  return contentType.includes("text/html") || contentType.includes("application/xhtml+xml");
}

/**
 * Replace both storages, and keep browser extensions from taking the page down. Their content
 * scripts run inside the sandboxed document too; one reading storage throws a SecurityError
 * that noVNC's global error handler would otherwise show in place of the screen.
 */
export function injectNovncStorageShim(html: string) {
  const shim = `<script>
(() => {
  const memoryStorage = () => {
    const items = new Map();
    return {
      getItem(key) { return items.has(String(key)) ? items.get(String(key)) : null; },
      setItem(key, value) { items.set(String(key), String(value)); },
      removeItem(key) { items.delete(String(key)); },
      clear() { items.clear(); },
    };
  };
  for (const name of ["localStorage", "sessionStorage"]) {
    Object.defineProperty(window, name, { configurable: true, value: memoryStorage() });
  }
  window.addEventListener("error", (event) => {
    if (/^[a-z-]+-extension:/.test(String(event.filename))) event.stopImmediatePropagation();
  }, true);
})();
</script>`;
  return html.includes("<head>")
    ? html.replace("<head>", `<head>${shim}`)
    : html.replace(/<script\b/i, `${shim}<script`);
}

/** Read a noVNC document with a hard cap, and fail if the upstream ends without `end`. */
export function collectNovncHtml(incoming: Readable, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      incoming.destroy();
      reject(error);
    };
    incoming.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > maxBytes) {
        fail(new Error(`noVNC document exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(buf);
    });
    incoming.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    incoming.on("error", (error: unknown) => {
      fail(error instanceof Error ? error : new Error("noVNC upstream failed"));
    });
    incoming.on("aborted", () => {
      fail(new Error("noVNC upstream aborted"));
    });
    incoming.on("close", () => {
      if (!settled) fail(new Error("noVNC upstream closed"));
    });
  });
}
