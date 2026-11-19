/** Keep a failed availability read retryable until the first successful response. */
export function showCalendarStatusRetry(status: {
  data: { available: boolean } | undefined;
  isError: boolean;
  isFetched: boolean;
  isFetching: boolean;
}): boolean {
  return (
    status.data?.available === undefined &&
    (status.isError || (status.isFetched && status.isFetching))
  );
}
