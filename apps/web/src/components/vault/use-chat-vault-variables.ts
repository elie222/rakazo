import { useLingui } from "@lingui/react/macro";
import type { VaultRead, VaultVariables } from "@rakazo/chat-ui/vault-variables";
import { useVaultVariableReads } from "@rakazo/chat-ui/vault-variables";
import type { SettingsScope } from "@rakazo/contracts";
import { toast } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { useSpaceQueries } from "../../lib/query/query";

/**
 * The viewer's command variables in the account's Vault and the Space's own, read once a message
 * on screen could name one. Each opens the Vault that holds it.
 */
export function useChatVaultVariables(
  openVault: (scope: SettingsScope, item: string) => void,
): VaultVariables {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const [wanted, setWanted] = useState(false);
  const overrides = useQuery({
    ...queries.spaceSettings.overrides.queryOptions(),
    enabled: wanted,
  });
  const spaceVault = Boolean(overrides.data?.includes("credentials"));
  const account = useQuery({
    ...queries.vault.list.queryOptions({ input: { scope: "account" } }),
    enabled: wanted,
  });
  const spaceList = queries.vault.list.queryOptions({ input: { scope: "space" } });
  const space = useQuery({ ...spaceList, enabled: wanted && spaceVault });
  const reads = useMemo(() => {
    if (!overrides.isSuccess || !account.data) return undefined;
    const vaults: VaultRead<SettingsScope>[] = [{ items: account.data, where: "account" }];
    if (!spaceVault) return vaults;
    // The Space's own Vault is the one its bots use, so it holds a name both export.
    return space.data ? [...vaults, { items: space.data, where: "space" as const }] : undefined;
  }, [overrides.isSuccess, account.data, space.data, spaceVault]);
  const { refetch: refetchAccount } = account;
  const { refetch: refetchSpace } = space;
  const readAgain = useCallback(async () => {
    const results = await Promise.all(
      spaceVault ? [refetchAccount(), refetchSpace()] : [refetchAccount()],
    );
    return results.every((result) => result.isSuccess);
  }, [refetchAccount, refetchSpace, spaceVault]);
  const { want, names, find } = useVaultVariableReads({
    reads,
    readsOf: JSON.stringify(spaceList.queryKey),
    setWanted,
    readAgain,
  });
  return useMemo(
    () => ({
      want,
      names,
      open: (name) => {
        const found = find(name);
        if (found) openVault(found.where, found.item);
      },
      denied: () => toast(t`You don't have access to this Vault secret.`),
      openLabel: (variable) => t`Open ${variable} in Vault`,
    }),
    [want, names, find, openVault, t],
  );
}
