import type { ToolSearchHit, ToolSearchRequest, ToolSearchResult } from "@rakazo/adapter-kit";
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

/** Rank the available hits, while reporting which sources could not answer. */
export async function searchToolSources(
  sources: readonly ToolSearchSource[],
  request: ToolSearchRequest,
): Promise<ToolSearchResult> {
  const found = await Promise.all(
    sources.map(async (source) => ({
      label: source.label,
      hits: await bestEffort(
        `find_tool ${source.label}`,
        "ids" in request ? source.find(request.ids) : source.search(request.query, request.limit),
      ),
    })),
  );
  const hits = found.flatMap((result) => result.hits ?? []);
  const unavailableSources = found.filter((result) => !result.hits).map((result) => result.label);
  return {
    hits:
      "ids" in request || request.source === "paid_services"
        ? hits
        : rankToolSearchHits([...(request.alongside ?? []), ...hits], request.query, request.limit),
    ...(unavailableSources.length ? { unavailableSources } : {}),
  };
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
