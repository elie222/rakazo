import type {
  AdapterContext,
  WebFetchRequest,
  WebFetchResult,
  WebProvider,
  WebSearchHit,
  WebSearchRequest,
} from "@rakazo/adapter-kit";

/**
 * Try providers in order until one answers. A search counts as answered when
 * it returns at least one hit; a fetch counts when it returns content. Every
 * failure is kept, so when nothing answers the error says which providers
 * were tried and why each one failed. This is how the web tools survive one
 * search vendor going down: the next provider in the chain takes over.
 */
export class FallbackWebProvider implements WebProvider {
  private readonly providers: WebProvider[];

  constructor(providers: WebProvider[]) {
    if (providers.length === 0)
      throw new Error("Fallback web provider needs at least one provider");
    this.providers = [...providers];
  }

  /** The providers in the chain, first tried first. */
  get chain(): readonly WebProvider[] {
    return this.providers;
  }

  describe() {
    return {
      id: "fallback",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        search: true,
        fetch: true,
        keyless: this.providers.every((provider) => provider.describe().capabilities.keyless),
        native: false,
        readability: this.providers.every(
          (provider) => provider.describe().capabilities.readability,
        ),
      },
    };
  }

  async search(request: WebSearchRequest, context: AdapterContext): Promise<WebSearchHit[]> {
    const errors: string[] = [];
    for (const provider of this.providers) {
      const id = provider.describe().id;
      try {
        const hits = await provider.search(request, context);
        if (hits.length > 0) return hits;
        errors.push(`${id}: no results`);
      } catch (error) {
        errors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (request.signal?.aborted || context.signal?.aborted) break;
    }
    throw new Error(`Web search failed on every provider: ${errors.join("; ")}`);
  }

  async fetch(request: WebFetchRequest, context: AdapterContext): Promise<WebFetchResult> {
    const errors: string[] = [];
    for (const provider of this.providers) {
      const id = provider.describe().id;
      try {
        return await provider.fetch(request, context);
      } catch (error) {
        errors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (request.signal?.aborted || context.signal?.aborted) break;
    }
    throw new Error(`Web fetch failed on every provider: ${errors.join("; ")}`);
  }
}
