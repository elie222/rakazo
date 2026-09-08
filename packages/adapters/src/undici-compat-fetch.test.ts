import { Agent } from "undici";
import { describe, expect, it } from "vitest";
import { fetchCompatibleWithUndiciAgent } from "./undici-compat-fetch.js";

describe("fetchCompatibleWithUndiciAgent", () => {
  it("uses undici fetch when paired with an undici Agent dispatcher", async () => {
    const transportFetch = fetchCompatibleWithUndiciAgent();
    const response = await transportFetch("https://example.com", {
      method: "HEAD",
      dispatcher: new Agent(),
    } as RequestInit & { dispatcher: Agent });
    await response.body?.cancel().catch(() => undefined);
    expect(response.status).toBeLessThan(500);
  });

  it("keeps injected fetch implementations for tests", () => {
    const mockFetch = async () => new Response("{}", { status: 200 });
    expect(fetchCompatibleWithUndiciAgent(mockFetch)).toBe(mockFetch);
  });
});
