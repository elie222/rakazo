import { describe, expect, it, vi } from "vitest";
import { OpenRouterUsageLookup, openRouterInferenceFetch } from "./openrouter-usage.js";

describe("OpenRouter attribution and usage recovery", () => {
  it("sends the normal user id and Rakazo attribution while preserving request controls", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("ok"));
    const controller = new AbortController();
    await openRouterInferenceFetch(fetcher, "user_fixture")(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        signal: controller.signal,
        headers: { Authorization: "Bearer fixture", "X-Fixture": "kept" },
        body: JSON.stringify({ model: "fixture", messages: [{ role: "user", content: "test" }] }),
      },
    );
    const init = fetcher.mock.calls[0]![1]!;
    const headers = new Headers(init.headers);
    expect(headers.get("HTTP-Referer")).toBe("https://rakazo.com");
    expect(headers.get("X-OpenRouter-Title")).toBe("Rakazo");
    expect(headers.get("Authorization")).toBe("Bearer fixture");
    expect(init.signal).toBe(controller.signal);
    expect(JSON.parse(String(init.body))).toMatchObject({ user: "user_fixture", model: "fixture" });
  });
  it("does not send ids or app attribution to compatible, lookalike, or non-inference endpoints", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("ok"));
    const init = { method: "POST", body: "{}" };
    const wrapped = openRouterInferenceFetch(fetcher, "user_fixture");
    for (const url of [
      "https://example.test/api/v1/chat/completions",
      "https://openrouter.ai.example.test/api/v1/chat/completions",
      "http://openrouter.ai/api/v1/chat/completions",
      "https://openrouter.ai/api/v1/keys",
    ])
      await wrapped(url, init);
    for (const [, sent] of fetcher.mock.calls) expect(sent).toBe(init);
  });
  it("supports Request inputs without consuming the caller's body", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("ok"));
    const request = new Request("https://openrouter.ai/api/v1/responses", {
      method: "POST",
      body: "{}",
    });
    await openRouterInferenceFetch(fetcher, "user_fixture")(request);
    expect(request.bodyUsed).toBe(false);
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body)).user).toBe("user_fixture");
  });
  it("replaces Request headers when init supplies headers, including removing old authorization", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("ok"));
    const request = new Request("https://openrouter.ai/api/v1/responses", {
      method: "POST",
      headers: { Authorization: "Bearer removed", "X-Old": "removed" },
      body: "{}",
    });
    await openRouterInferenceFetch(fetcher, "user_fixture")(request, {
      headers: { "X-New": "kept" },
      body: null,
    });
    const sent = fetcher.mock.calls[0]![1]!;
    const headers = new Headers(sent.headers);
    expect(headers.has("Authorization")).toBe(false);
    expect(headers.has("X-Old")).toBe(false);
    expect(headers.get("X-New")).toBe("kept");
    expect(JSON.parse(String(sent.body))).toMatchObject({ user: "user_fixture" });
    expect(request.bodyUsed).toBe(false);
  });
  it("recovers authoritative costs and separates cache reads from uncached input", async () => {
    const lookup = new OpenRouterUsageLookup("fixture", async () =>
      Response.json({
        data: {
          id: "gen_fixture",
          total_cost: 0.0123,
          native_tokens_prompt: 100,
          native_tokens_cached: 40,
          native_tokens_completion: 20,
          native_tokens_reasoning: 5,
        },
      }),
    );
    await expect(lookup.lookupUsage("gen_fixture")).resolves.toMatchObject({
      providerRequestId: "gen_fixture",
      costUsd: 0.0123,
      costSource: "provider-reported",
      inputTokens: 60,
      outputTokens: 20,
      cacheReadTokens: 40,
      totalTokens: 120,
    });
  });
  it("adds the upstream cost of a bring-your-own-key generation and waits when it is missing", async () => {
    const generation = (upstream_inference_cost: number | null) =>
      new OpenRouterUsageLookup("fixture", async () =>
        Response.json({
          data: { id: "gen-fixture", total_cost: 0.0001, is_byok: true, upstream_inference_cost },
        }),
      ).lookupUsage("gen-fixture");
    expect((await generation(0.002))?.costUsd).toBeCloseTo(0.0021);
    await expect(generation(null)).resolves.toBeNull();
  });
  it("never treats missing usage as free and rejects mismatched generation ids", async () => {
    await expect(
      new OpenRouterUsageLookup(
        "fixture",
        async () => new Response(null, { status: 404 }),
      ).lookupUsage("gen_fixture"),
    ).resolves.toBeNull();
    await expect(
      new OpenRouterUsageLookup("fixture", async () =>
        Response.json({ data: { id: "other", total_cost: 0 } }),
      ).lookupUsage("gen_fixture"),
    ).rejects.toThrow("different generation");
  });
});
