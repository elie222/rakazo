import type { ToolSearchHit, ToolSearchRequest } from "@rakazo/adapter-kit";
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
): Promise<ToolSearchHit[]> {
  const hits = await searchToolSources(await runSearchSources(ctx), request);
  // Tool and service descriptions come from outside; the app catalog is the deployment's own.
  const outside = hits.filter((hit) => hit.next !== "connect_app");
  if (outside.length) await markReadOutsideContent(ctx, outside);
  return hits;
}

async function runSearchSources(ctx: RunContext): Promise<ToolSearchSource[]> {
  const { deps, context, runId } = ctx;
  const offered = (name: string) => ctx.tools.offered.some((tool) => tool.name === name);
  const sources: ToolSearchSource[] = [];
  if (deps.connector)
    sources.push(
      connectorCatalogSource(deps.connector, context, ctx.tools.offered, `find-tool:${runId}`),
    );
  const apps = deps.connectors?.managedProviders?.() ?? [];
  if (apps.length && offered("connect_app")) sources.push(appCatalogSource(apps, context));
  const paid = ctx.providers.paidServices;
  if (paid && offered("service_call"))
    sources.push(paidServiceSource(paid, context, await modelCreditBillingEnabled(deps)));
  return sources;
}
