/** A change signal makes any read already in flight older than the change. */
export async function refreshQueriesAfterSignal<Filters extends object>(
  client: {
    cancelQueries(filters: Filters & { type: "active" }): Promise<void>;
    invalidateQueries(filters: Filters): Promise<void>;
  },
  filters: Filters,
): Promise<void> {
  // Invalidation alone reuses an initial fetch while it has no cached data yet.
  // Unobserved fetches have callers awaiting their result rather than a refreshed observer.
  await client.cancelQueries({ ...filters, type: "active" });
  await client.invalidateQueries(filters);
}
