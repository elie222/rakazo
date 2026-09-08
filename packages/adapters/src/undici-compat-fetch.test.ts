import { MockAgent } from "undici";
import { describe, expect, it } from "vitest";
import { fetchCompatibleWithUndiciAgent } from "./undici-compat-fetch.js";

describe("fetchCompatibleWithUndiciAgent", () => {
  it("uses undici fetch when paired with an undici Agent dispatcher", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    agent.get("https://example.test").intercept({ path: "/", method: "HEAD" }).reply(200);
    try {
      const transportFetch = fetchCompatibleWithUndiciAgent();
      const response = await transportFetch("https://example.test/", {
        method: "HEAD",
        dispatcher: agent,
      } as RequestInit & { dispatcher: MockAgent });
      await response.body?.cancel().catch(() => undefined);
      expect(response.status).toBe(200);
    } finally {
      await agent.close();
    }
  });

  it("keeps injected fetch implementations for tests", () => {
    const mockFetch = async () => new Response("{}", { status: 200 });
    expect(fetchCompatibleWithUndiciAgent(mockFetch)).toBe(mockFetch);
  });
});
