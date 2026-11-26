import type {
  AdapterContext,
  ConnectorEvent,
  ConnectorProvider,
  ConnectorRoute,
  ConnectorTool,
  ToolSearchHit,
} from "@rakazo/adapter-kit";
import type { CatalogSearchHit } from "../lazy-tool-catalog.js";
import {
  CATALOG_LOAD,
  CATALOG_SEARCH,
  MAX_DESCRIPTION_LENGTH,
  UnknownCatalogToolError,
} from "../lazy-tool-catalog.js";
import type { ToolSearchSource } from "./tool-search.js";

/** Hits per connector whose parameters are loaded; the ranked list keeps few of them anyway. */
const LOADED_PER_CONNECTOR = 3;

type Loaded = { name: string; description: string; inputSchema: Record<string, unknown> };

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
      { tool: toolName, args, executionId: `${executionId}:${calls++}`, route },
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
    })) as Loaded | undefined;
    if (!loaded?.inputSchema) return undefined;
    return {
      id,
      name: loaded.name,
      description: loaded.description.slice(0, MAX_DESCRIPTION_LENGTH),
      next: "use_tool",
      inputSchema: loaded.inputSchema,
      connectorId,
    };
  };
  return {
    label: "connected tools",
    async search(query, limit) {
      const found = await Promise.all(
        catalogs.map(async (connectorId) => {
          const result = (await control(connectorId, CATALOG_SEARCH, { query, limit })) as
            | { tools?: CatalogSearchHit[] }
            | undefined;
          const hits = (result?.tools ?? []).slice(0, LOADED_PER_CONNECTOR);
          return Promise.all(hits.map((hit) => load(connectorId, hit.id)));
        }),
      );
      return found.flat().filter((hit) => hit !== undefined);
    },
    async find(ids) {
      const found = await Promise.all(
        ids.flatMap((id) => catalogs.map((connectorId) => load(connectorId, id))),
      );
      return found.filter((hit) => hit !== undefined);
    },
  };
}
