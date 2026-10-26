import { fetchFresh, writeSaved } from "@rakazo/core/query";
import { useQuery } from "@tanstack/react-query";
import { loadSessionToken, rpc } from "./api";
import { queryClient, rpcQuery } from "./query";

const LIST = "trustedLinkSites/list" as const;
const none: readonly string[] = [];

/** The signed-in user's trusted link sites: links to them open without the external-link prompt. */
export function trustedLinkSitesRead() {
  return rpcQuery(LIST);
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

// The sites hold in every space, so a save updates the copy cached under each one.
async function save(update: (current: string[]) => string[]) {
  await writeSaved(queryClient, trustedLinkSitesRead().queryKey, (current) =>
    update(current ?? []),
  );
  queryClient.setQueriesData<string[]>(
    { predicate: (query) => query.queryKey.includes(LIST) },
    (current) => (current ? update(current) : current),
  );
}

export async function trustLinkSite(url: string): Promise<void> {
  const { site } = await rpc("trustedLinkSites/trust", { url });
  await save((current) => (current.includes(site) ? current : [...current, site].sort()));
}

export async function removeTrustedLinkSite(site: string): Promise<void> {
  await rpc("trustedLinkSites/remove", { site });
  await save((current) => current.filter((item) => item !== site));
}
