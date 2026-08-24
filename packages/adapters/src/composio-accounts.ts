import {
  accountDefaultSelector,
  accountsForExternalId,
  accountsFromConnections,
  addAccountParameter,
  type ConnectorAccountRef,
  resolveConnectorAccount,
  stripAccountArg,
} from "./connector-accounts.js";

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

function toComposioAccount(account: ConnectorAccountRef, email?: string): ComposioAccountRef {
  return {
    toolkit: account.externalId,
    id: account.id,
    alias: account.alias,
    ...(email ? { email } : {}),
  };
}

function toConnectorAccounts(accounts: readonly ComposioAccountRef[]): ConnectorAccountRef[] {
  return accounts.map((account) => ({
    externalId: account.toolkit,
    id: account.id,
    alias: account.alias,
  }));
}

export function composioAccountsFromConnections(
  connections: readonly ComposioConnectionRow[] | undefined,
): ComposioAccountRef[] {
  return accountsFromConnections(connections).map((account) => toComposioAccount(account));
}

export function stripComposioAccount(args: Record<string, unknown>): {
  args: Record<string, unknown>;
  account?: string;
} {
  return stripAccountArg(args);
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
    if (!ids.includes(id) && ids.length < 10) ids.push(id);
  }
  return {
    multiAccount: {
      enable: true,
      maxAccountsPerToolkit: 10,
      requireExplicitSelection: true,
    },
    connectedAccounts,
  };
}

export function accountsForComposioToolkit(
  accounts: ComposioAccountRef[],
  toolkit: string,
): ComposioAccountRef[] {
  const byId = new Map(accounts.map((account) => [account.id, account]));
  return accountsForExternalId(toConnectorAccounts(accounts), toolkit).map(
    (account) => byId.get(account.id) ?? toComposioAccount(account),
  );
}

export function composioAccountDefaultSelector(
  accountDefaults: Record<string, string> | undefined,
  toolkit: string,
): string | undefined {
  return accountDefaultSelector(accountDefaults, "composio", toolkit);
}

export function resolveComposioAccount(
  accounts: ComposioAccountRef[],
  toolkit: string,
  requested?: string,
  defaultAlias?: string,
): ComposioAccountRef | undefined {
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const resolved = resolveConnectorAccount(
    toConnectorAccounts(accounts),
    toolkit,
    requested,
    defaultAlias,
  );
  return resolved ? (byId.get(resolved.id) ?? toComposioAccount(resolved)) : undefined;
}

export function addComposioAccountParameter(
  inputSchema: Record<string, unknown>,
  accounts: ComposioAccountRef[],
  defaultSelector?: string,
): Record<string, unknown> {
  return addAccountParameter(inputSchema, toConnectorAccounts(accounts), defaultSelector);
}
