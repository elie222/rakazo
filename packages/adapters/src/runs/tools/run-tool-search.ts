import type { ToolSearchRequest, ToolSearchResult } from "@rakazo/adapter-kit";
import { PAID_SERVICE_SEARCH_LIMIT } from "../../payments/paid-service-tools.js";
import { appCatalogSource } from "../../tools/tool-search/app-catalog-source.js";
import { connectorCatalogSource } from "../../tools/tool-search/connector-catalog-source.js";
import { paidServiceSource } from "../../tools/tool-search/paid-service-source.js";
import type { ToolSearchSource } from "../../tools/tool-search/tool-search.js";
import { searchToolSources } from "../../tools/tool-search/tool-search.js";
import type { RunContext } from "../assembly/run-context.js";
import { markReadOutsideContent } from "../assembly/run-context.js";
import { modelCreditBillingEnabled } from "../turn/run-model.js";

/**
 * find_tool's search beyond the listed tools, over what this run was offered: a connector's held
 * back tools, apps to connect when connect_app is offered, paid services when service_call is.
 */
export async function searchRunTools(
  ctx: RunContext,
  request: ToolSearchRequest,
): Promise<ToolSearchResult> {
  const sources = runSearchSources(ctx, request.source);
  if (request.source === "paid_services" && !sources.length)
    return { hits: [], unavailableSources: ["paid services"] };
  const result = await searchToolSources(
    sources,
    request.source === "paid_services" && "query" in request
      ? { ...request, limit: PAID_SERVICE_SEARCH_LIMIT }
      : request,
  );
  // Held-back tool and service descriptions come from outside. The app catalog is the
  // deployment's own, and hits the runtime passed alongside were already in front of the model.
  const alongside = new Set("alongside" in request ? request.alongside : []);
  const outside = result.hits.filter((hit) => hit.next !== "connect_app" && !alongside.has(hit));
  if (outside.length) await markReadOutsideContent(ctx, outside);
  return result;
}

function runSearchSources(
  ctx: RunContext,
  source: ToolSearchRequest["source"],
): ToolSearchSource[] {
  const { deps, context, runId } = ctx;
  const offered = (name: string) => ctx.tools.offered.some((tool) => tool.name === name);
  const paid = ctx.providers.paidServices;
  const paidSource =
    paid && offered("service_call")
      ? paidServiceSource(paid, context, () => modelCreditBillingEnabled(deps))
      : undefined;
  if (source === "paid_services") return paidSource ? [paidSource] : [];

  const sources: ToolSearchSource[] = [];
  if (deps.connector)
    sources.push(
      connectorCatalogSource(deps.connector, context, ctx.tools.offered, `find-tool:${runId}`),
    );
  const apps = deps.connectors?.managedProviders?.() ?? [];
  if (apps.length && offered("connect_app")) sources.push(appCatalogSource(apps, context));
  if (paidSource) sources.push(paidSource);
  return sources;
}
