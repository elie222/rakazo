import { useLingui } from "@lingui/react/macro";
import type { VaultVariables } from "@rakazo/chat-ui/web";
import type { BotSecretMetadata, SettingsScope } from "@rakazo/contracts";
import { commandVariableName } from "@rakazo/contracts";
import { toast } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
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
  const space = useQuery({
    ...queries.vault.list.queryOptions({ input: { scope: "space" } }),
    enabled: wanted && spaceVault,
  });
  const read = overrides.isSuccess && account.data && (!spaceVault || space.data);
  const vaults = useMemo(() => {
    if (!read) return undefined;
    const byName = new Map<string, { scope: SettingsScope; item: string }>();
    const add = (scope: SettingsScope, items: readonly BotSecretMetadata[] | undefined) => {
      for (const item of items ?? [])
        if (item.auth?.type === "command")
          byName.set(commandVariableName(item.name), { scope, item: item.name });
    };
    add("account", account.data);
    // The Space's own Vault is the one its bots use, so it holds a name both export.
    if (spaceVault) add("space", space.data);
    return byName;
  }, [read, account.data, space.data, spaceVault]);
  return useMemo(
    () => ({
      want: () => setWanted(true),
      names: vaults && new Set(vaults.keys()),
      open: (name) => {
        const found = vaults?.get(name);
        if (found) openVault(found.scope, found.item);
      },
      denied: () => toast(t`You don't have access to this Vault secret.`),
      openLabel: (variable) => t`Open ${variable} in Vault`,
    }),
    [vaults, openVault, t],
  );
}
