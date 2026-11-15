import { describe, expect, it } from "vitest";
import middleware from "../middleware";

function request(path: string, accept?: string, method = "GET"): Request {
  return new Request(`https://rakazo.com${path}`, {
    method,
    headers: accept ? { accept } : {},
  });
}

describe("middleware", () => {
  it("renders markdown it holds at the page's own URL", async () => {
    const response = middleware(request("/about/", "text/markdown"));
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await response.text()).toContain("# About Rakazo");
  });

  it("rewrites to the static markdown file for blog, docs, pricing and integrations", () => {
    for (const [path, file] of [
      ["/blog/self-host-an-ai-agent/", "/blog/self-host-an-ai-agent.md"],
      ["/blog/", "/blog.md"],
      ["/docs/routines/", "/docs/routines.md"],
      ["/pricing/", "/pricing.md"],
      ["/integrations/gmail/", "/integrations/gmail.md"],
    ]) {
      const response = middleware(request(path, "text/markdown"));
      expect(response.headers.get("x-middleware-rewrite")).toBe(`https://rakazo.com${file}`);
      expect(response.headers.get("vary")).toBe("Accept, Accept-Encoding");
      expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    }
  });

  it("serves HTML when Accept names neither HTML nor markdown", () => {
    const response = middleware(request("/about/", "application/json"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("advertises the markdown twin on HTML responses", () => {
    const response = middleware(request("/blog/self-host-an-ai-agent/", "text/html"));
    expect(response.headers.get("link")).toContain(
      '</blog/self-host-an-ai-agent.md>; rel="alternate"; type="text/markdown"',
    );
  });
});
