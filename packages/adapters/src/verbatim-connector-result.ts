import type { AgentRunRequest, ConnectorRoute } from "@rakazo/adapter-kit";
import { GROUP_SEPARATORS } from "./lazy-tool-catalog.js";

/** App connections whose tool results must stay whole. */
export type VerbatimConnections = NonNullable<AgentRunRequest["verbatimConnections"]>;

function matchesPrefix(
  toolName: string,
  prefix: string,
  excludedPrefixes: readonly string[] | undefined,
): boolean {
  const normalized = toolName.trim().toLowerCase();
  if (!normalized.startsWith(prefix)) return false;
  return !excludedPrefixes?.some(
    (candidate) => candidate.length > prefix.length && normalized.startsWith(candidate),
  );
}

function matchesCatalogId(
  id: string,
  connectionIds: readonly string[],
  providers: readonly string[],
): boolean {
  if (!id) return false;
  if (
    connectionIds.some(
      (connectionId) =>
        id.startsWith(`${connectionId}:`) ||
        id.includes(`:${encodeURIComponent(connectionId)}:`) ||
        id.includes(`:${connectionId}:`) ||
        id.includes(`; ${connectionId})`),
    )
  ) {
    return true;
  }
  const lower = id.toLowerCase();
  return providers.some((provider) => {
    const key = provider.trim().toLowerCase();
    if (!key) return false;
    return (
      GROUP_SEPARATORS.some((separator) => lower.startsWith(`${key}${separator}`)) ||
      lower.startsWith(`${key} (`)
    );
  });
}

function accountFromArgs(
  argObject: Record<string, unknown> | undefined,
  rule: NonNullable<VerbatimConnections["prefixRules"]>[number],
): string | undefined {
  if (!argObject) return undefined;
  const keys = [
    rule.batchItemAccountKey,
    "account",
    "connected_account_id",
    "connectedAccountId",
  ].filter(Boolean) as string[];
  for (const key of keys) {
    const value = argObject[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function prefixAllowed(
  matchedPrefix: string,
  rule: NonNullable<VerbatimConnections["prefixRules"]>[number],
  argObject: Record<string, unknown> | undefined,
): boolean {
  const allowedAccounts = rule.allowedAccountsByPrefix?.[matchedPrefix];
  if (!allowedAccounts) return true;
  if (allowedAccounts.length === 0) return false;
  const account = accountFromArgs(argObject, rule);
  return Boolean(account && allowedAccounts.includes(account));
}

export function isVerbatimConnectorResult(
  name: string | undefined,
  args: unknown,
  targets: VerbatimConnections | undefined,
  route?: Pick<ConnectorRoute, "connectionId" | "toolName">,
): boolean {
  if (!targets) return false;
  if (route?.connectionId && targets.connectionIds?.includes(route.connectionId)) {
    return true;
  }
  if (!name) return false;
  if (targets.toolNames?.includes(name)) return true;
  if (route?.toolName && targets.toolNames?.includes(route.toolName)) return true;

  if (targets.catalogMatches?.length) {
    const id =
      args && typeof args === "object" && "id" in args && typeof args.id === "string"
        ? args.id.trim()
        : "";
    for (const match of targets.catalogMatches) {
      if (
        name === match.executeToolName &&
        matchesCatalogId(id, match.connectionIds, match.providers)
      ) {
        return true;
      }
    }
  }

  if (targets.prefixRules?.length) {
    const argObject =
      args && typeof args === "object" ? (args as Record<string, unknown>) : undefined;
    for (const rule of targets.prefixRules) {
      const matchedPrefix = rule.prefixes.find((prefix) =>
        matchesPrefix(name, prefix, rule.excludedPrefixes),
      );
      if (matchedPrefix && prefixAllowed(matchedPrefix, rule, argObject)) {
        return true;
      }
      if (
        argObject &&
        rule.batchToolNames?.includes(name) &&
        rule.batchItemsKey &&
        rule.batchItemToolKey
      ) {
        const items = argObject[rule.batchItemsKey];
        if (Array.isArray(items)) {
          const hit = items.some((item) => {
            if (!item || typeof item !== "object") return false;
            const record = item as Record<string, unknown>;
            const slug = record[rule.batchItemToolKey!];
            if (typeof slug !== "string") return false;
            const matchedPrefix = rule.prefixes.find((prefix) =>
              matchesPrefix(slug, prefix, rule.excludedPrefixes),
            );
            if (!matchedPrefix) return false;
            const allowedAccounts = rule.allowedAccountsByPrefix?.[matchedPrefix];
            if (allowedAccounts) {
              if (
                !rule.batchItemAccountKey ||
                typeof record[rule.batchItemAccountKey] !== "string"
              ) {
                return false;
              }
              return allowedAccounts.includes((record[rule.batchItemAccountKey] as string).trim());
            }
            return true;
          });
          if (hit) return true;
        }
      }
    }
  }

  return false;
}
