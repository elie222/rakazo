export interface ConnectorAccountRef {
  externalId: string;
  id: string;
  alias: string;
}

export interface ConnectorConnectionRow {
  externalId: string;
  providerRef?: string | null;
  displayName: string;
}

function normalizeExternalId(externalId: string): string {
  return externalId.trim().toLowerCase();
}

/** True when providerRef is only a legacy app slug, not a concrete account id. */
export function isLegacyAppSlugRef(providerRef: string, externalId: string): boolean {
  return normalizeExternalId(providerRef) === normalizeExternalId(externalId);
}

export function accountsFromConnections(
  connections: readonly ConnectorConnectionRow[] | undefined,
): ConnectorAccountRef[] {
  const aliases = new Map<string, number>();
  const accounts: ConnectorAccountRef[] = [];
  for (const connection of connections ?? []) {
    const externalId = normalizeExternalId(connection.externalId);
    const id = connection.providerRef?.trim() ?? "";
    if (!externalId || !id || isLegacyAppSlugRef(id, externalId)) continue;
    const baseAlias = connection.displayName.trim() || `${externalId} account`;
    const key = `${externalId}:${baseAlias.toLowerCase()}`;
    const count = (aliases.get(key) ?? 0) + 1;
    aliases.set(key, count);
    accounts.push({
      externalId,
      id,
      alias: count === 1 ? baseAlias : `${baseAlias} ${count}`,
    });
  }
  return accounts;
}

export function stripAccountArg(args: Record<string, unknown>): {
  args: Record<string, unknown>;
  account?: string;
} {
  const { account, ...providerArgs } = args;
  return typeof account === "string" && account.trim()
    ? { account: account.trim(), args: providerArgs }
    : { args: providerArgs };
}

export function accountsForExternalId(
  accounts: ConnectorAccountRef[],
  externalId: string,
): ConnectorAccountRef[] {
  const normalized = normalizeExternalId(externalId);
  return accounts.filter((account) => normalizeExternalId(account.externalId) === normalized);
}

export function accountDefaultSelector(
  accountDefaults: Record<string, string> | undefined,
  connectorId: string,
  externalId: string,
): string | undefined {
  if (!accountDefaults) return undefined;
  const normalized = normalizeExternalId(externalId);
  return (
    accountDefaults[`${connectorId}:${normalized}`] ??
    accountDefaults[`${connectorId}:${normalized.toUpperCase()}`] ??
    accountDefaults[`${connectorId}:${externalId}`]
  );
}

export function resolveConnectorAccount(
  accounts: ConnectorAccountRef[],
  externalId: string,
  requested?: string,
  defaultSelector?: string,
): ConnectorAccountRef | undefined {
  const candidates = accountsForExternalId(accounts, externalId);
  if (candidates.length === 0) return undefined;
  const selector = requested?.trim() || defaultSelector?.trim();
  if (selector) {
    return candidates.find((account) => account.id === selector || account.alias === selector);
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function addAccountParameter(
  inputSchema: Record<string, unknown>,
  accounts: ConnectorAccountRef[],
  defaultSelector?: string,
): Record<string, unknown> {
  if (accounts.length <= 1) return inputSchema;
  const hasDefault = Boolean(
    defaultSelector &&
      accounts.some(
        (account) => account.id === defaultSelector || account.alias === defaultSelector,
      ),
  );
  const properties =
    inputSchema.properties &&
    typeof inputSchema.properties === "object" &&
    !Array.isArray(inputSchema.properties)
      ? { ...(inputSchema.properties as Record<string, unknown>) }
      : {};
  properties.account = {
    type: "string",
    enum: accounts.map((account) => account.alias),
    description: hasDefault ? "Account alias. Uses bot default if omitted." : "Account alias.",
  };
  const required = Array.isArray(inputSchema.required)
    ? [
        ...inputSchema.required.filter(
          (value): value is string =>
            typeof value === "string" && (!hasDefault || value !== "account"),
        ),
      ]
    : [];
  if (!hasDefault && !required.includes("account")) required.push("account");
  return { ...inputSchema, properties, required };
}
