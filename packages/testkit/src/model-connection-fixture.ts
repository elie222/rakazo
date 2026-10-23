/**
 * Providers whose catalog is public, so their key is checked on a separate
 * endpoint. Literal URLs, mirroring the table in the adapters package: the test
 * harness imports this file before the Prisma client exists, and importing
 * `@rakazo/adapters` here would load the database client too early.
 */
const KEY_CHECK_URLS: Record<string, string> = {
  openrouter: "https://openrouter.ai/api/v1/key",
  "ollama-cloud": "https://ollama.com/api/balance",
};

const MODELS_URLS: Record<string, string> = {
  openrouter: "https://openrouter.ai/api/v1/models",
  "ollama-cloud": "https://ollama.com/v1/models",
};

/** Offline provider HTTP; the public catalogs deliberately accept rejected keys. */
export function createModelConnectionFixtureFetch(
  catalog: ReadonlyArray<{ provider: string; id: string }>,
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    const keyCheck = Object.entries(KEY_CHECK_URLS).find(([, url]) => url === request.url);
    if (keyCheck) {
      const authorization = request.headers.get("authorization");
      const accepted =
        authorization?.startsWith("Bearer ") && authorization !== "Bearer rejected-fixture-key";
      return Response.json({ data: {} }, { status: accepted ? 200 : 401 });
    }
    const models = Object.entries(MODELS_URLS).find(([, url]) => url === request.url);
    if (models) {
      const [provider] = models;
      return Response.json({
        data: catalog
          .filter((model) => model.provider === provider)
          .map((model) => ({ id: model.id })),
      });
    }
    throw new Error("Unexpected model connection request in the offline fixture");
  };
}
