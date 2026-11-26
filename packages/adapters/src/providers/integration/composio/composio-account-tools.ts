import type {
  AdapterContext,
  ConnectedConnector,
  ConnectorCall,
  ConnectorEvent,
  ConnectorTool,
} from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import { catalogToolPrefix } from "../../../approvals/approval-effect.js";
import { scopeConnectorTools } from "../../../integrations/connector-accounts.js";
import {
  CATALOG_EXECUTE,
  catalogEntries,
  DIRECT_TOOL_LIMIT,
  executeLazyCatalogControl,
  isLazyCatalogControlRoute,
  lazyCatalogTools,
  resolveCatalogCall,
} from "../../../tools/lazy-tool-catalog.js";
import type { ComposioSession } from "./composio-connector.js";
import {
  composioResultError,
  sanitizeIntegrationError,
  sanitizePayload,
} from "./composio-errors.js";

export function composioOwner(context: Pick<AdapterContext, "userId" | "organizationId">) {
  return context.organizationId ? `organization:${context.organizationId}` : context.userId;
}

function scopedAccounts(context: AdapterContext) {
  const accounts = (context.connectedConnections ?? []).filter(
    (account) => account.connectorId === "composio",
  );
  const personalCounts = new Map<string, number>();
  for (const account of accounts) {
    if (account.organizationId) continue;
    const app = account.externalId.toLowerCase();
    personalCounts.set(app, (personalCounts.get(app) ?? 0) + 1);
  }
  return accounts.filter(
    (account) =>
      account.organizationId || (personalCounts.get(account.externalId.toLowerCase()) ?? 0) > 1,
  );
}

/** Accounts sharing an app have exact routes to sessions scoped to their credentials. */
export function composioAccountTools(
  list: (context: AdapterContext, app: string) => Promise<ConnectorTool[]>,
  sessionFor: (
    context: AdapterContext,
    connection: ConnectedConnector,
  ) => Promise<{ session?: ComposioSession; connectedAccounts: Record<string, string[]> }>,
) {
  async function tools(context: AdapterContext) {
    const catalogs = new Map<string, Promise<ConnectorTool[]>>();
    const groups = await Promise.all(
      scopedAccounts(context).map(async (account) => {
        const app = account.externalId.toLowerCase();
        let catalog = catalogs.get(app);
        if (!catalog) {
          catalog = list(context, account.externalId).catch((error) => {
            getLogger().warn("Connected account tools unavailable", {
              error: sanitizeIntegrationError(error),
            });
            return [];
          });
          catalogs.set(app, catalog);
        }
        return scopeConnectorTools(await catalog, account);
      }),
    );
    return groups.flat();
  }

  async function* execute(
    call: ConnectorCall,
    context: AdapterContext,
  ): AsyncIterable<ConnectorEvent> {
    try {
      if (isLazyCatalogControlRoute(call.route)) {
        yield* executeLazyCatalogControl(call, catalogEntries(await tools(context)), (resolved) =>
          execute(resolved, context),
        );
        return;
      }
      const route = call.route;
      const account = scopedAccounts(context).find(
        ({ id, externalId, providerRef }) =>
          route?.connectionId === id &&
          route.resourceId === externalId &&
          route.resourceRevision === providerRef,
      );
      if (!account || !route) {
        yield { type: "error", message: "The selected connected account is unavailable." };
        return;
      }
      const { session, connectedAccounts } = await sessionFor(
        { ...context, organizationId: account.organizationId },
        account,
      );
      if (!session) {
        yield { type: "error", message: "The selected account needs to be reconnected." };
        return;
      }
      const ref = account.providerRef;
      const pinned = ref && Object.values(connectedAccounts).some((ids) => ids.includes(ref));
      if (ref && ref.toLowerCase() !== account.externalId.toLowerCase() && !pinned) {
        yield { type: "error", message: "The selected account needs to be reconnected." };
        return;
      }
      const result = await session.execute(
        route.toolName,
        call.args,
        pinned ? { account: ref } : undefined,
      );
      if (result.error || result.resultType !== "completed") {
        yield {
          type: "error",
          message: sanitizeIntegrationError(
            composioResultError(result.error || `${route.toolName} failed`, result.data),
          ),
        };
        return;
      }
      yield { type: "result", data: sanitizePayload({ data: result.data, logId: result.logId }) };
    } catch (error) {
      yield { type: "error", message: sanitizeIntegrationError(error) };
    }
  }

  return {
    async discoverTools(context: AdapterContext) {
      const available = await tools(context);
      return available.length > DIRECT_TOOL_LIMIT
        ? lazyCatalogTools(
            catalogToolPrefix("composio"),
            "composio",
            "app",
            catalogEntries(available),
          )
        : available;
    },
    async resolveCall(call: ConnectorCall, context: AdapterContext) {
      if (!isLazyCatalogControlRoute(call.route) || call.route?.toolName !== CATALOG_EXECUTE)
        return undefined;
      return resolveCatalogCall(call, catalogEntries(await tools(context)));
    },
    execute,
  };
}
