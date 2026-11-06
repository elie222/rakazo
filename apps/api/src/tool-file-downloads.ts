import type { PrismaToolFileStore } from "@rakazo/adapters";
import { TOOL_FILE_DOWNLOAD_PATH } from "@rakazo/adapters";
import { getLogger } from "@rakazo/logging";
import type { Context, Hono } from "hono";
import { throttleKey, windowCounter } from "./window-counter.js";

const MINUTE_MS = 60_000;
const DOWNLOADS_PER_IP_PER_MINUTE = 60;

const BASE_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
};

/**
 * The signed links `{{file_url:…}}` placeholders become: whatever a tool hands the link to
 * downloads a temporary tool file here, signed out. Every link that does not serve a file gets
 * the same 404, and the token never reaches a log (requests log their route, not their path).
 */
export function mountToolFileDownloads(
  app: Hono,
  toolFiles: Pick<PrismaToolFileStore, "download">,
  clientIp: (c: Context) => string | undefined,
) {
  const downloads = windowCounter(MINUTE_MS);
  app.get(`${TOOL_FILE_DOWNLOAD_PATH}:token`, async (c) => {
    if (downloads(throttleKey(clientIp(c))) > DOWNLOADS_PER_IP_PER_MINUTE) {
      return c.json({ error: "Too many requests" }, 429, {
        ...BASE_HEADERS,
        "retry-after": "60",
      });
    }
    let found: Awaited<ReturnType<typeof toolFiles.download>>;
    try {
      found = await toolFiles.download(c.req.param("token"));
    } catch (error) {
      // A file whose bytes are gone is as unavailable as an expired one.
      getLogger().warn("tool.file.download.failed", {
        "error.message": error instanceof Error ? error.message : String(error),
      });
      found = undefined;
    }
    if (!found) return c.json({ error: "Not found" }, 404, BASE_HEADERS);
    const { file, bytes } = found;
    return c.body(new Uint8Array(bytes), 200, {
      ...BASE_HEADERS,
      "content-type": file.mimeType,
      "content-length": String(bytes.byteLength),
      "content-disposition": contentDisposition(file.name),
      // Never rendered as a page on the API's origin, whatever the type says.
      "content-security-policy": "default-src 'none'; sandbox",
    });
  });
}

/** `attachment` with an ASCII fallback name and the exact name as RFC 5987 UTF-8. */
export function contentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\%]/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(name)}`;
}

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
