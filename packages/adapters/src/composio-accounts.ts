export interface ComposioAccountRef {
  toolkit: string;
  id: string;
  alias: string;
  email?: string;
}

export interface ComposioMultiAccountOptions {
  multiAccount: {
    enable: true;
    maxAccountsPerToolkit: number;
    requireExplicitSelection: true;
  };
  connectedAccounts: Record<string, string[]>;
}

export interface ComposioConnectionRow {
  externalId: string;
  providerRef?: string | null;
  displayName: string;
}

function normalizeToolkit(toolkit: string): string {
  return toolkit.trim().toLowerCase();
}

export function composioAccountsFromConnections(
  connections: readonly ComposioConnectionRow[] | undefined,
): ComposioAccountRef[] {
  const aliases = new Map<string, number>();
  const accounts: ComposioAccountRef[] = [];
  for (const connection of connections ?? []) {
    const toolkit = normalizeToolkit(connection.externalId);
    const id = connection.providerRef?.trim() ?? "";
    if (!toolkit || !id || normalizeToolkit(id) === toolkit) continue;
    const baseAlias = connection.displayName.trim() || `${toolkit} account`;
    const key = `${toolkit}:${baseAlias.toLowerCase()}`;
    const count = (aliases.get(key) ?? 0) + 1;
    aliases.set(key, count);
    accounts.push({
      toolkit,
      id,
      alias: count === 1 ? baseAlias : `${baseAlias} ${count}`,
    });
  }
  return accounts;
}

export function stripComposioAccount(args: Record<string, unknown>): {
  args: Record<string, unknown>;
  account?: string;
} {
  const { account, ...providerArgs } = args;
  return typeof account === "string" && account.trim()
    ? { account: account.trim(), args: providerArgs }
    : { args: providerArgs };
}

export function buildComposioMultiAccountOptions(
  accounts: ComposioAccountRef[],
): ComposioMultiAccountOptions {
  const connectedAccounts: Record<string, string[]> = {};
  for (const account of accounts) {
    const toolkit = account.toolkit.trim();
    const id = account.id.trim();
    if (!toolkit || !id) continue;
    const ids = connectedAccounts[toolkit] ?? [];
    connectedAccounts[toolkit] = ids;
    if (!ids.includes(id)) ids.push(id);
  }
  return {
    multiAccount: {
      enable: true,
      maxAccountsPerToolkit: 5,
      requireExplicitSelection: true,
    },
    connectedAccounts,
  };
}

export function resolveComposioAccount(
  accounts: ComposioAccountRef[],
  toolkit: string,
  requested?: string,
  defaultAlias?: string,
): ComposioAccountRef | undefined {
  const candidates = accounts.filter(
    (account) => normalizeToolkit(account.toolkit) === normalizeToolkit(toolkit),
  );
  if (candidates.length === 0) return undefined;
  const selector = requested?.trim() || defaultAlias?.trim();
  if (selector) {
    return candidates.find((account) => account.id === selector || account.alias === selector);
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function addComposioAccountParameter(
  inputSchema: Record<string, unknown>,
  accounts: ComposioAccountRef[],
): Record<string, unknown> {
  if (accounts.length <= 1) return inputSchema;
  const properties =
    inputSchema.properties &&
    typeof inputSchema.properties === "object" &&
    !Array.isArray(inputSchema.properties)
      ? { ...(inputSchema.properties as Record<string, unknown>) }
      : {};
  properties.account = {
    type: "string",
    enum: accounts.map((account) => account.alias),
    description: "Connected account alias. Required when more than one account is connected.",
  };
  const required = Array.isArray(inputSchema.required)
    ? [...inputSchema.required.filter((value): value is string => typeof value === "string")]
    : [];
  if (!required.includes("account")) required.push("account");
  return { ...inputSchema, properties, required };
}
