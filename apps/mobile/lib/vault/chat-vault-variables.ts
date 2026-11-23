import { useLingui } from "@lingui/react/macro";
import type { VaultVariables } from "@rakazo/chat-ui/native";
import type { BotSecretMetadata } from "@rakazo/contracts";
import { commandVariableName } from "@rakazo/contracts";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useMemo, useState, useSyncExternalStore } from "react";
import { Alert } from "react-native";
import { selectedSpaceId, subscribeSpaceSelection } from "../api/api";
import { queryClient, rpcQuery } from "../query/query";

/**
 * The viewer's command variables in the account's Vault and the selected Space's own, read once a
 * message on screen could name one. Each opens the Vault that holds it.
 */
export function useChatVaultVariables(): VaultVariables {
  const { t } = useLingui();
  const router = useRouter();
  const spaceId = useSyncExternalStore(subscribeSpaceSelection, selectedSpaceId);
  const [wanted, setWanted] = useState(false);
  const overrides = useQuery(
    { ...rpcQuery("spaceSettings/overrides"), enabled: wanted && spaceId !== null },
    queryClient,
  );
  const spaceVault = Boolean(overrides.data?.includes("credentials"));
  const account = useQuery(
    { ...rpcQuery("vault/list", { scope: "account" }), enabled: wanted && spaceId !== null },
    queryClient,
  );
  // Read as the Vault screen reads a Space's own, so both share what was read.
  const space = useQuery(
    {
      ...rpcQuery("vault/list", { scope: "space" }, spaceId ?? undefined),
      enabled: wanted && spaceVault,
    },
    queryClient,
  );
  const read = overrides.isSuccess && account.data && (!spaceVault || space.data);
  const vaults = useMemo(() => {
    if (!read) return undefined;
    const byName = new Map<string, { item: string; spaceId?: string }>();
    const add = (items: readonly BotSecretMetadata[] | undefined, owner?: { spaceId: string }) => {
      for (const item of items ?? [])
        if (item.auth?.type === "command")
          byName.set(commandVariableName(item.name), { item: item.name, ...owner });
    };
    add(account.data);
    // The Space's own Vault is the one its bots use, so it holds a name both export.
    if (spaceVault && spaceId) add(space.data, { spaceId });
    return byName;
  }, [read, account.data, space.data, spaceVault, spaceId]);
  return useMemo(
    () => ({
      want: () => setWanted(true),
      names: vaults && new Set(vaults.keys()),
      open: (name) => {
        const found = vaults?.get(name);
        if (found) router.push({ pathname: "/vault", params: found });
      },
      denied: () => Alert.alert(t`You don't have access to this Vault secret.`),
      openLabel: (variable) => t`Open ${variable} in Vault`,
    }),
    [vaults, router, t],
  );
}
