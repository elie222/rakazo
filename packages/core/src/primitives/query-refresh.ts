/** A change signal makes any read already in flight older than the change. */
export async function refreshQueriesAfterSignal<Filters>(
  client: {
    cancelQueries(filters: Filters): Promise<void>;
    invalidateQueries(filters: Filters): Promise<void>;
  },
  filters: Filters,
): Promise<void> {
  // Invalidation alone reuses an initial fetch while it has no cached data yet.
  await client.cancelQueries(filters);
  await client.invalidateQueries(filters);
}
