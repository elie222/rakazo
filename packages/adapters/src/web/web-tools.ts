import type { AdapterContext, WebFetchProvider, WebSearchProvider } from "@rakazo/adapter-kit";
import { imageToolResult } from "../media/tool-result-image.js";
import { clampMaxChars, clampMaxResults, clampOffset } from "./web-limits.js";

export async function webSearchFromTool(
  search: WebSearchProvider,
  context: AdapterContext,
  args: Record<string, unknown>,
) {
  const query = String(args.query ?? "").trim();
  if (!query) return { error: "query is required" };
  try {
    const results = await search.search(
      {
        query,
        maxResults: clampMaxResults(args.maxResults),
        signal: context.signal,
      },
      context,
    );
    return { results };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** A picture comes back as image input when the run's model can see, and as a short note when not. */
export async function webFetchFromTool(
  fetchProvider: WebFetchProvider,
  context: AdapterContext,
  args: Record<string, unknown>,
  modelSeesImages = false,
) {
  const url = String(args.url ?? "").trim();
  if (!url) return { error: "url is required" };
  try {
    const result = await fetchProvider.fetch(
      {
        url,
        maxChars: clampMaxChars(args.maxChars),
        offset: clampOffset(args.offset),
        signal: context.signal,
      },
      context,
    );
    if (result.image)
      return await imageToolResult(result.image, { url: result.url }, modelSeesImages);
    return result;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
