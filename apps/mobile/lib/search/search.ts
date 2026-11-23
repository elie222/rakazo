import type { SearchHit } from "@rakazo/contracts";
import { SEARCH_QUERY_MAX_LENGTH } from "@rakazo/contracts";
import { sliceWellFormed } from "@rakazo/core";
import { rpc } from "../api/api";

/** The exact query the server receives after trimming and safely cutting the raw input. */
export function normalizeSpaceSearchQuery(query: string): string {
  return sliceWellFormed(query.trim(), SEARCH_QUERY_MAX_LENGTH);
}

export async function querySpaceSearch(q: string, signal?: AbortSignal): Promise<SearchHit[]> {
  const query = normalizeSpaceSearchQuery(q);
  if (!query) return [];
  const result = await rpc("search/query", { q: query }, { signal });
  return result.hits;
}
