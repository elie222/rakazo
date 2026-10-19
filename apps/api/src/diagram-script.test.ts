import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { DIAGRAM_SCRIPT_PATH, mountDiagramScript } from "./diagram-script.js";

const app = new Hono();
mountDiagramScript(app);

describe("diagram script route", () => {
  it("serves the Mermaid browser bundle as a cacheable public script", async () => {
    const response = await app.request(DIAGRAM_SCRIPT_PATH);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("etag")).toMatch(/^"mermaid-\d+\.\d+\.\d+"$/);
    const body = await response.text();
    // The IIFE build defines a global the WebView document reads.
    expect(body).toContain('globalThis["mermaid"]');
  });

  it.each([
    ["strong", (etag: string) => etag],
    ["weak", (etag: string) => `W/${etag}`],
    ["list", (etag: string) => `"other,tag", W/${etag}, "another"`],
    ["wildcard", () => " * "],
  ])("answers a matching %s revalidation without the body", async (_name, validator) => {
    const etag = (await app.request(DIAGRAM_SCRIPT_PATH)).headers.get("etag") ?? "";
    const response = await app.request(DIAGRAM_SCRIPT_PATH, {
      headers: { "if-none-match": validator(etag) },
    });
    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
    expect(response.headers.get("etag")).toBe(etag);
  });
  it.each(['"other,tag"', 'W/"other"', '"other", "another"'])(
    "serves the body for a nonmatching validator %s",
    async (validator) => {
      const response = await app.request(DIAGRAM_SCRIPT_PATH, {
        headers: { "if-none-match": validator },
      });
      expect(response.status).toBe(200);
      expect((await response.text()).length).toBeGreaterThan(0);
    },
  );
});
