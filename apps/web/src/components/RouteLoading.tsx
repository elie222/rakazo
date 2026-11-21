import { PageLoading } from "./PageLoading";

/** A route-level wait: a short silence, then a quiet spinner instead of a hard flash. */
export function RouteLoading() {
  return <PageLoading delay={120} />;
}
