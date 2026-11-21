import type { SearchHit } from "@rakazo/contracts";
import { SEARCH_QUERY_MAX_LENGTH } from "@rakazo/contracts";
import { sliceWellFormed } from "@rakazo/core";
import { rpc } from "../api/api";

export async function querySpaceSearch(q: string, signal?: AbortSignal): Promise<SearchHit[]> {
  const trimmed = q.trim();
  if (!trimmed) return [];
  const query = sliceWellFormed(trimmed, SEARCH_QUERY_MAX_LENGTH);
  const result = await rpc("search/query", { q: query }, { signal });
  return result.hits;
}
