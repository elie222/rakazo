/** Offline provider HTTP; the public catalog deliberately accepts rejected keys. */
export function createModelConnectionFixtureFetch(
  catalog: ReadonlyArray<{ provider: string; id: string }>,
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    if (
      request.url === "https://openrouter.ai/api/v1/key" ||
      request.url === "https://ollama.com/api/balance" ||
      request.url === "https://api.deepinfra.com/v1/me"
    ) {
      const authorization = request.headers.get("authorization");
      const accepted =
        authorization?.startsWith("Bearer ") && authorization !== "Bearer rejected-fixture-key";
      return Response.json({ data: {} }, { status: accepted ? 200 : 401 });
    }
    if (request.url === "https://openrouter.ai/api/v1/models") {
      return Response.json({
        data: catalog
          .filter((model) => model.provider === "openrouter")
          .map((model) => ({ id: model.id })),
      });
    }
    if (request.url === "https://ollama.com/v1/models") {
      return Response.json({ data: [{ id: "fixture-model" }] });
    }
    if (request.url === "https://api.deepinfra.com/v1/openai/models") {
      return Response.json({
        data: [
          {
            id: "fixture-model",
            metadata: {
              context_length: 131072,
              pricing: { input_tokens: 0.5, output_tokens: 1, cache_read_tokens: 0.25 },
              tags: ["chat", "vision", "reasoning_effort", "prompt_cache"],
            },
          },
          { id: "fixture-image-model", metadata: { tags: ["image-gen"] } },
        ],
      });
    }
    throw new Error("Unexpected model connection request in the offline fixture");
  };
}
