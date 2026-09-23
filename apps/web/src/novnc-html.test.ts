import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { collectNovncHtml, MAX_NOVNC_HTML_BYTES } from "./novnc-html.js";

describe("CreateOS noVNC HTML rewrite", () => {
  it("returns a document that ends", async () => {
    const html = await collectNovncHtml(Readable.from([Buffer.from("<html></html>")]), 1024);
    expect(html).toBe("<html></html>");
  });

  it("rejects a document over the size cap", async () => {
    const stream = Readable.from([Buffer.alloc(MAX_NOVNC_HTML_BYTES + 1)]);
    await expect(collectNovncHtml(stream, MAX_NOVNC_HTML_BYTES)).rejects.toThrow(/exceeds/);
  });

  it("rejects an upstream abort that never ends", async () => {
    const stream = new Readable({ read() {} });
    const pending = collectNovncHtml(stream, 1024);
    stream.emit("aborted");
    await expect(pending).rejects.toThrow(/aborted/);
  });

  it("rejects an upstream close that never ends", async () => {
    const stream = new Readable({ read() {} });
    const pending = collectNovncHtml(stream, 1024);
    stream.emit("close");
    await expect(pending).rejects.toThrow(/closed/);
  });
});
