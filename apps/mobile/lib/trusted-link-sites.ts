import { fetchFresh, writeSaved } from "@rakazo/core/query";
import { useQuery } from "@tanstack/react-query";
import { loadSessionToken, rpc } from "./api";
import { accountRpcQuery, queryClient } from "./query";

const none: readonly string[] = [];

/** The signed-in user's trusted link sites: links to them open without the external-link prompt. */
export function trustedLinkSitesRead() {
  return accountRpcQuery("trustedLinkSites/list");
}

/** What the last read or save left; the chat prompt and Settings both show it. */
export function useTrustedLinkSites(): readonly string[] {
  return useQuery({ ...trustedLinkSitesRead(), enabled: false }, queryClient).data ?? none;
}

/** Reads the list again when someone is signed in. */
export async function loadTrustedLinkSites(): Promise<void> {
  if (await loadSessionToken())
    await fetchFresh(queryClient, trustedLinkSitesRead(), { reuse: true });
}

// Each change takes the list's key before it sends, so a reply that lands after someone else
// signs in is saved under the session that asked, never in the new user's list.

export async function trustLinkSite(url: string): Promise<void> {
  const read = trustedLinkSitesRead();
  const { site } = await rpc("trustedLinkSites/trust", { url });
  const loaded = queryClient.getQueryData(read.queryKey) !== undefined;
  await writeSaved(queryClient, read.queryKey, (current = []) =>
    current.includes(site) ? current : [...current, site].sort(),
  );
  // Saved before the first read finished: the cache holds only this site until read again.
  if (!loaded) void fetchFresh(queryClient, read).catch(() => undefined);
}

export async function removeTrustedLinkSite(site: string): Promise<void> {
  const { queryKey } = trustedLinkSitesRead();
  await rpc("trustedLinkSites/remove", { site });
  await writeSaved(queryClient, queryKey, (current = []) =>
    current.filter((item) => item !== site),
  );
}
