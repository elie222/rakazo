import { useLingui } from "@lingui/react/macro";
import type { VaultRead, VaultVariables } from "@rakazo/chat-ui/vault-variables";
import { useVaultVariableReads } from "@rakazo/chat-ui/vault-variables";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { Alert } from "react-native";
import {
  currentApiBase,
  selectedSpaceId,
  subscribeApiBase,
  subscribeSpaceSelection,
} from "../api/api";
import { currentSessionGeneration, subscribeSessionGeneration } from "../api/session";
import { queryClient, rpcQuery } from "../query/query";

/** Where the Vault screen opens an item: the account's Vault, or the Space's own. */
type VaultOwner = { spaceId?: string };

/**
 * The viewer's command variables in the account's Vault and the selected Space's own, read once a
 * message on screen could name one. Each opens the Vault that holds it.
 */
export function useChatVaultVariables(): VaultVariables {
  const { t } = useLingui();
  const router = useRouter();
  const spaceId = useSyncExternalStore(subscribeSpaceSelection, selectedSpaceId);
  // A name checked before a sign-in or a server switch is checked again after it.
  const server = useSyncExternalStore(subscribeApiBase, currentApiBase);
  const session = useSyncExternalStore(subscribeSessionGeneration, currentSessionGeneration);
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
  const reads = useMemo(() => {
    if (!overrides.isSuccess || !account.data) return undefined;
    const vaults: VaultRead<VaultOwner>[] = [{ items: account.data, where: {} }];
    if (!spaceVault || !spaceId) return vaults;
    // The Space's own Vault is the one its bots use, so it holds a name both export.
    return space.data ? [...vaults, { items: space.data, where: { spaceId } }] : undefined;
  }, [overrides.isSuccess, account.data, space.data, spaceVault, spaceId]);
  const { refetch: refetchAccount } = account;
  const { refetch: refetchSpace } = space;
  const readAgain = useCallback(async () => {
    // A read already under way for another name answers this one too.
    const again = { cancelRefetch: false };
    const results = await Promise.all(
      spaceVault ? [refetchAccount(again), refetchSpace(again)] : [refetchAccount(again)],
    );
    return results.every((result) => result.isSuccess);
  }, [refetchAccount, refetchSpace, spaceVault]);
  const { want, names, find } = useVaultVariableReads({
    reads,
    readsOf: `${server}\n${session}\n${spaceId ?? ""}`,
    setWanted,
    readAgain,
  });
  return useMemo(
    () => ({
      want,
      names,
      open: (name) => {
        const found = find(name);
        if (found)
          router.push({ pathname: "/vault", params: { item: found.item, ...found.where } });
      },
      denied: () => Alert.alert(t`You don't have access to this Vault secret.`),
      openLabel: (variable) => t`Open ${variable} in Vault`,
    }),
    [want, names, find, router, t],
  );
}
