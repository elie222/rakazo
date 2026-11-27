import type { ToolSearchHit, ToolSearchRequest } from "@rakazo/adapter-kit";
import { bestEffort } from "@rakazo/logging";
import { catalogEntryScore } from "../lazy-tool-catalog.js";

/** Where find_tool looks beyond the tools a run lists: connected tools, apps, paid services. */
export interface ToolSearchSource {
  readonly label: string;
  /** Hits for the query, best first. */
  search(query: string, limit: number): Promise<ToolSearchHit[]>;
  /** The hits with these exact ids. */
  find(ids: readonly string[]): Promise<ToolSearchHit[]>;
}

export const FIND_TOOL_LIMIT = 5;

/** Every source's hits for one request, ranked together. One source failing hides only its hits. */
export async function searchToolSources(
  sources: readonly ToolSearchSource[],
  request: ToolSearchRequest,
): Promise<ToolSearchHit[]> {
  const found = await Promise.all(
    sources.map(
      async (source) =>
        (await bestEffort(
          `find_tool ${source.label}`,
          "ids" in request ? source.find(request.ids) : source.search(request.query, request.limit),
        )) ?? [],
    ),
  );
  return "ids" in request
    ? found.flat()
    : rankToolSearchHits(
        [...(request.alongside ?? []), ...found.flat()],
        request.query,
        request.limit,
      );
}

/**
 * The best `limit` hits for a query, whatever source each came from. Each source already chose
 * hits for the query, so a hit sharing no word with it (a service found by meaning) ranks last
 * rather than dropping out; ties keep their order.
 */
export function rankToolSearchHits(
  hits: readonly ToolSearchHit[],
  query: string,
  limit: number,
): ToolSearchHit[] {
  return hits
    .map((hit, index) => ({ hit, index, ...hitScore(hit, query) }))
    .sort(
      (left, right) =>
        right.score - left.score || right.matched - left.matched || left.index - right.index,
    )
    .slice(0, limit)
    .map(({ hit }) => hit);
}

function hitScore(hit: ToolSearchHit, query: string) {
  const exact = [hit.id, hit.name].some(
    (name) => name.toLowerCase() === query.trim().toLowerCase(),
  );
  if (exact) return { matched: 1, score: Number.MAX_SAFE_INTEGER };
  return catalogEntryScore(
    {
      id: hit.id,
      group: "",
      tool: { name: hit.name, description: hit.description, inputSchema: {} },
    },
    query,
  );
}

/** What find_tool shows for a hit: the argument its next step takes, and what that step needs. */
export function shownToolSearchHit(
  hit: ToolSearchHit,
): { next: ToolSearchHit["next"] } & Record<string, unknown> {
  const argument = { use_tool: "name", connect_app: "app", service_call: "service" }[hit.next];
  return {
    next: hit.next,
    [argument]: hit.id,
    ...(hit.name !== hit.id ? { title: hit.name } : {}),
    ...(hit.description ? { description: hit.description } : {}),
    ...(hit.inputSchema ? { inputSchema: hit.inputSchema } : {}),
    ...hit.details,
  };
}
