import { describe, expect, it } from "vitest";
import middleware from "../middleware";

describe("marketing site middleware", () => {
  it("negotiates Markdown on the canonical page URL", async () => {
    const response = middleware(
      new Request("https://rakazo.com/", {
        headers: { accept: "text/markdown,text/html;q=0.8" },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8",
    );
    expect(response.headers.get("vary")).toBe("Accept, Accept-Encoding");
    await expect(response.text()).resolves.toContain("# Rakazo");
  });

  it("gives generic agent fetches a recoverable Markdown 404", async () => {
    const response = middleware(
      new Request("https://rakazo.com/does-not-exist", {
        headers: { accept: "*/*" },
      }),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8",
    );
    await expect(response.text()).resolves.toContain(
      "https://rakazo.com/sitemap-index.xml",
    );
  });

  it("returns 406 for representations the site does not provide", async () => {
    const response = middleware(
      new Request("https://rakazo.com/", {
        headers: { accept: "application/json" },
      }),
    );

    expect(response.status).toBe(406);
    expect(response.headers.get("vary")).toBe("Accept, Accept-Encoding");
    await expect(response.text()).resolves.toContain(
      "text/html or text/markdown",
    );
  });

  it("continues browser requests with negotiation-safe response headers", () => {
    const response = middleware(
      new Request("https://rakazo.com/", {
        headers: { accept: "text/html" },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("vary")).toBe("Accept, Accept-Encoding");
    expect(response.headers.get("link")).toContain("/index.md");
  });
});
