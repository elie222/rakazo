export function composioSlugKey(slug: string): string {
  return slug.trim().toLowerCase();
}

export type PluginConnectionRow = {
  id: string;
  provider: string;
  status: string;
  displayName: string;
  /** When the row last changed; for a pending row, when its authorization began. */
  updatedAt?: Date;
  /** The account its sign-in creates, the app's slug for an app without one, or nothing yet. */
  providerRef?: string | null;
};

/**
 * Composio expires an authorization nobody finished about ten minutes after it began. Until
 * then the person may still be on the app's sign-in page, so the row is not abandoned yet.
 */
export const AUTHORIZATION_WINDOW_MS = 15 * 60 * 1000;

function stillAuthorizing(row: PluginConnectionRow, now: number): boolean {
  return (
    row.status === "pending" &&
    row.updatedAt !== undefined &&
    now - row.updatedAt.getTime() < AUTHORIZATION_WINDOW_MS
  );
}

export function needsLivePluginSync(rows: { status: string }[]): boolean {
  return rows.some((row) => row.status === "pending" || row.status === "error");
}

export function personalComposioConnections<
  T extends { connectorId: string; organizationId?: string | null },
>(connections: readonly T[]): T[] {
  return connections.filter((row) => row.connectorId === "composio" && !row.organizationId);
}

export function mergeConnectedPlugins(
  rows: { provider: string; displayName: string; status?: string }[],
  liveSlugs: string[],
): { provider: string; displayName: string }[] {
  const live = new Set(liveSlugs.map((slug) => composioSlugKey(slug)).filter(Boolean));
  const byProvider = new Map<string, { provider: string; displayName: string }>();
  for (const row of rows) {
    if (!row.provider) continue;
    const include =
      row.status === "connected" ||
      row.status === undefined ||
      ((row.status === "pending" || row.status === "error") &&
        live.has(composioSlugKey(row.provider)));
    if (!include) continue;
    const current = byProvider.get(composioSlugKey(row.provider));
    if (!current || composioSlugKey(current.displayName) === composioSlugKey(current.provider)) {
      byProvider.set(composioSlugKey(row.provider), {
        provider: row.provider,
        displayName: row.displayName,
      });
    }
  }
  return [...byProvider.values()];
}

/** Reuse a revoked/error row only when this provider has no live sibling. */
export function pickReusableConnection<T extends { id: string; status: string }>(
  rows: T[],
): T | undefined {
  if (rows.some((row) => row.status === "connected" || row.status === "pending")) {
    return undefined;
  }
  return rows.find((row) => row.status === "revoked" || row.status === "error");
}

/**
 * The row to connect for an app the provider reports signed in. Trying again leaves an earlier
 * row holding a sign-in nobody finished, so the row is the one whose own account is live, and
 * the latest attempt when the live accounts are unknown.
 */
function signedInRow(
  rows: PluginConnectionRow[],
  slug: string,
  liveRefs: Set<string> | undefined,
): PluginConnectionRow | undefined {
  const latestFirst = rows
    .filter((row) => row.status === "pending" || row.status === "error")
    .sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0));
  if (!liveRefs) return latestFirst[0];
  const holdsNoAccount = (row: PluginConnectionRow) =>
    !row.providerRef || composioSlugKey(row.providerRef) === slug;
  return (
    latestFirst.find((row) => row.providerRef && liveRefs.has(row.providerRef)) ??
    latestFirst.find(holdsNoAccount)
  );
}

export function planLiveConnectionSync(
  rows: PluginConnectionRow[],
  liveSlugs: string[],
  now = Date.now(),
  liveRefs?: string[],
): { connectIds: string[]; revokeIds: string[] } {
  const liveRefSet = liveRefs && new Set(liveRefs);
  const live = new Set(liveSlugs.map(composioSlugKey).filter(Boolean));
  const connectIds: string[] = [];
  const connectedProviders = new Set(
    rows.filter((row) => row.status === "connected").map((row) => composioSlugKey(row.provider)),
  );
  for (const slug of live) {
    if (connectedProviders.has(slug)) continue;
    const matches = rows.filter((row) => composioSlugKey(row.provider) === slug);
    // Recover in-flight pending/error rows only. A revoked sibling stays
    // revoked even when another row (or the upstream listing) is live for
    // the same slug — reviving it would reattach a dead providerRef.
    const reusable = signedInRow(matches, slug, liveRefSet);
    if (!reusable) continue;
    connectIds.push(reusable.id);
    connectedProviders.add(slug);
  }
  // A further attempt whose own sign-in finished is another account of an app that is
  // already connected, left unfinished only because its page stopped asking.
  for (const row of rows) {
    if (row.status !== "pending" || connectIds.includes(row.id)) continue;
    if (row.providerRef && liveRefSet?.has(row.providerRef)) connectIds.push(row.id);
  }
  const connectIdSet = new Set(connectIds);
  // Providers that already have a connected row before this sync. An extra pending row for
  // one is an additional-account attempt: kept while its sign-in page may still be open, or
  // when its age is unknown, and cleared after that. Concurrent pendings with no connected
  // row yet still collapse to one connect + revoke the rest.
  const previouslyConnected = new Set(
    rows.filter((row) => row.status === "connected").map((row) => composioSlugKey(row.provider)),
  );
  const revokeIds = rows
    .filter((row) => {
      if (row.status !== "pending" && row.status !== "error") return false;
      if (connectIdSet.has(row.id)) return false;
      // Revoking it would cancel a sign-in the person is in the middle of.
      if (stillAuthorizing(row, now)) return false;
      // Keep an additional-account pending whose age is unknown; one past the authorization
      // window was abandoned, and so is an error, which would otherwise be re-listed forever.
      if (
        row.status === "pending" &&
        row.updatedAt === undefined &&
        previouslyConnected.has(composioSlugKey(row.provider))
      ) {
        return false;
      }
      return true;
    })
    .map((row) => row.id);
  return { connectIds, revokeIds };
}
