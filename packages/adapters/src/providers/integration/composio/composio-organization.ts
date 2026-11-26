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

function organizationAccounts(context: AdapterContext) {
  return (context.connectedConnections ?? []).filter(
    (account) => account.connectorId === "composio" && account.organizationId,
  );
}

/** Personal sessions keep their own accounts. Shared actions have exact routes to an org session. */
export function organizationConnector(
  list: (context: AdapterContext, app: string) => Promise<ConnectorTool[]>,
  sessionFor: (
    context: AdapterContext,
    connection: ConnectedConnector,
  ) => Promise<{ session?: ComposioSession; connectedAccounts: Record<string, string[]> }>,
) {
  async function tools(context: AdapterContext) {
    const groups = await Promise.all(
      organizationAccounts(context).map(async (account) => {
        try {
          return scopeConnectorTools(await list(context, account.externalId), account);
        } catch (error) {
          getLogger().warn("Organization app tools unavailable", {
            error: sanitizeIntegrationError(error),
          });
          return [];
        }
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
      const account = organizationAccounts(context).find(
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
        yield { type: "error", message: "The organization connection needs to be reconnected." };
        return;
      }
      const ref = account.providerRef;
      const pinned = ref && Object.values(connectedAccounts).some((ids) => ids.includes(ref));
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
