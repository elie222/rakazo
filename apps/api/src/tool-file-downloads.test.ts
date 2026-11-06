import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { contentDisposition, mountToolFileDownloads } from "./tool-file-downloads.js";

const TOKEN = "a".repeat(43);
const bytes = new TextEncoder().encode("col1,col2\n1,2\n");

function harness(
  download: (token: string) => Promise<
    | {
        file: { id: string; name: string; mimeType: string; size: number; expiresAt: Date };
        bytes: Uint8Array;
      }
    | undefined
  >,
) {
  const app = new Hono();
  const store = { download: vi.fn(download) };
  mountToolFileDownloads(app, store, (c) => c.req.header("x-test-ip"));
  const get = (token: string, ip = "203.0.113.7") =>
    app.request(`/api/tool-files/${token}`, { headers: { "x-test-ip": ip } });
  return { get, store };
}

const served = async () => ({
  file: {
    id: "tf1",
    name: "Rapport été.csv",
    mimeType: "text/csv",
    size: bytes.byteLength,
    expiresAt: new Date(),
  },
  bytes,
});

describe("tool file download route", () => {
  it("serves the bytes as a download that is never cached, sniffed or rendered", async () => {
    const { get, store } = harness(served);

    const response = await get(TOKEN);

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(store.download).toHaveBeenCalledWith(TOKEN);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "content-type": "text/csv",
      "content-length": String(bytes.byteLength),
      "content-disposition": `attachment; filename="Rapport _t_.csv"; filename*=UTF-8''Rapport%20%C3%A9t%C3%A9.csv`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    });
  });

  it("answers the same 404 for an unknown, expired or used-up link", async () => {
    const { get } = harness(async () => undefined);

    const response = await get(TOKEN);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("answers 404 when the file's bytes cannot be read", async () => {
    const { get } = harness(async () => {
      throw new Error("missing blob");
    });

    expect((await get(TOKEN)).status).toBe(404);
  });

  it("limits how often one address can try links", async () => {
    const { get, store } = harness(async () => undefined);

    for (let i = 0; i < 60; i += 1) expect((await get(TOKEN)).status).toBe(404);
    const limited = await get(TOKEN);

    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(store.download).toHaveBeenCalledTimes(60);
    // Another address is not affected.
    expect((await get(TOKEN, "198.51.100.9")).status).toBe(404);
  });
});

describe("content disposition", () => {
  it("escapes quotes and keeps the exact name for clients that read UTF-8", () => {
    expect(contentDisposition('a "b".txt')).toBe(
      `attachment; filename="a _b_.txt"; filename*=UTF-8''a%20%22b%22.txt`,
    );
    expect(contentDisposition("it's (1).pdf")).toBe(
      `attachment; filename="it's (1).pdf"; filename*=UTF-8''it%27s%20%281%29.pdf`,
    );
  });
});
