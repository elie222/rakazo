import type {
  AdapterContext,
  ConnectorEvent,
  ConnectorProvider,
  ConnectorRoute,
  ConnectorTool,
  ToolSearchHit,
} from "@rakazo/adapter-kit";
import { bestEffort } from "@rakazo/logging";
import type { CatalogSearchHit } from "../lazy-tool-catalog.js";
import { CATALOG_LOAD, CATALOG_SEARCH, UnknownCatalogToolError } from "../lazy-tool-catalog.js";
import type { ToolSearchSource } from "./tool-search.js";

/** Hits per connector whose parameters are loaded; the ranked list keeps few of them anyway. */
const LOADED_PER_CONNECTOR = 3;

/**
 * Connected tools a connector holds back from the tool list, found through its catalog. use_tool
 * runs a hit through that connector's catalog, so approvals and audit stay the connector's.
 */
export function connectorCatalogSource(
  connector: Pick<ConnectorProvider, "execute">,
  context: AdapterContext,
  offered: readonly ConnectorTool[],
  executionId: string,
): ToolSearchSource {
  const catalogs = offered.flatMap((tool) =>
    tool.route && !tool.route.resourceId && tool.route.toolName === CATALOG_SEARCH
      ? [tool.route.connectorId]
      : [],
  );
  let calls = 0;
  const control = async (connectorId: string, toolName: string, args: Record<string, unknown>) => {
    const route: ConnectorRoute = { connectorId, toolName };
    for await (const event of connector.execute(
      {
        tool: toolName,
        args,
        executionId: `${executionId}:${calls++}`,
        route,
        withCatalogSchemas: true,
      },
      context,
    ) as AsyncIterable<ConnectorEvent>) {
      if (event.type === "result") return event.data;
      if (event.type === "error") throw new Error(event.message);
    }
    return undefined;
  };
  // A catalog that does not hold the id answers with an error, which is no hit, not a failure.
  const load = async (connectorId: string, id: string): Promise<ToolSearchHit | undefined> => {
    const loaded = (await control(connectorId, CATALOG_LOAD, { id }).catch((error: unknown) => {
      if (error instanceof Error && error.message === new UnknownCatalogToolError().message)
        return undefined;
      throw error;
    })) as CatalogSearchHit | undefined;
    return loaded?.inputSchema
      ? { ...connectorHit(loaded, connectorId), matchedName: id }
      : undefined;
  };
  // One connector failing hides only its own tools; bestEffort logs why.
  const fromEach = async <T>(work: (connectorId: string) => Promise<T[]>) =>
    (
      await Promise.all(
        catalogs.map(
          async (connectorId) =>
            (await bestEffort(`find_tool catalog ${connectorId}`, work(connectorId))) ?? [],
        ),
      )
    )
      .flat()
      .filter((hit) => hit !== undefined);
  return {
    label: "connected tools",
    search: (query, limit) =>
      fromEach(async (connectorId) => {
        const result = (await control(connectorId, CATALOG_SEARCH, {
          query,
          limit: Math.min(limit, LOADED_PER_CONNECTOR),
        })) as { tools: CatalogSearchHit[] } | undefined;
        return (result?.tools ?? []).map((hit) => connectorHit(hit, connectorId));
      }),
    find: (ids) => fromEach((connectorId) => Promise.all(ids.map((id) => load(connectorId, id)))),
  };
}

function connectorHit(
  { id, name, description, inputSchema }: CatalogSearchHit,
  connectorId: string,
): ToolSearchHit {
  return { id, name, description, inputSchema, next: "use_tool", connectorId };
}
