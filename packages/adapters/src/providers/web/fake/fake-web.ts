import type {
  AdapterContext,
  WebFetchRequest,
  WebFetchResult,
  WebProvider,
  WebSearchHit,
  WebSearchRequest,
} from "@rakazo/adapter-kit";
import { clampOffset, pageWindow } from "../../../web/web-limits.js";

/** In-memory web provider for offline tests. Never hits the network. */
export class FakeWebProvider implements WebProvider {
  searchHits: WebSearchHit[] = [];
  fetchResult: WebFetchResult = {
    url: "https://example.test/page",
    title: "Example",
    text: "Hello from fake web",
    truncated: false,
  };
  /** Text served for these exact URLs instead of `fetchResult`. */
  pages: Record<string, string> = {};
  /** Picture bytes served for these exact URLs. */
  images: Record<string, Uint8Array> = {};
  lastSearch?: WebSearchRequest;
  lastFetch?: WebFetchRequest;
  searchError?: Error;
  fetchError?: Error;

  describe() {
    return {
      id: "fake",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        search: true,
        fetch: true,
        keyless: true,
        native: false,
        readability: true,
      },
    };
  }

  async search(request: WebSearchRequest, _context: AdapterContext): Promise<WebSearchHit[]> {
    this.lastSearch = request;
    if (this.searchError) throw this.searchError;
    const limit = request.maxResults ?? this.searchHits.length;
    return this.searchHits.slice(0, limit);
  }

  async fetch(request: WebFetchRequest, _context: AdapterContext): Promise<WebFetchResult> {
    this.lastFetch = request;
    if (this.fetchError) throw this.fetchError;
    const image = this.images[request.url];
    if (image) return { url: request.url, title: "", text: "", truncated: false, image };
    const page = this.pages[request.url];
    const result = page === undefined ? this.fetchResult : { ...this.fetchResult, text: page };
    const offset = clampOffset(request.offset);
    const rest = result.text.slice(offset);
    const maxChars = request.maxChars ?? rest.length;
    const window = pageWindow(rest, maxChars, offset);
    return {
      ...result,
      url: request.url || result.url,
      text: window.text,
      truncated: window.truncated || result.truncated,
    };
  }
}
