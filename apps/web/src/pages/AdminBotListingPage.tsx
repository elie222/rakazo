import { Trans } from "@lingui/react/macro";
import { Spinner } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { Navigate, useParams } from "react-router-dom";
import { AdminBotListingForm } from "../components/bot-marketplace/admin-bot-listing-form";
import { PageLoading } from "../components/PageLoading";
import { WindowChrome } from "../components/WindowChrome";
import { useSpaceQueries } from "../lib/query/query";

/** `/admin/bots/new` makes a listing; `/admin/bots/:slug` changes one. */
export function AdminBotListingPage() {
  const { slug } = useParams();
  const queries = useSpaceQueries();
  const me = useQuery(queries.me.queryOptions());
  const rows = useQuery({
    ...queries.botMarketplace.admin.list.queryOptions({ input: {} }),
    enabled: Boolean(slug) && me.data?.isAdmin === true,
  });
  if (me.isPending) return <PageLoading />;
  if (!me.data?.isAdmin) return <Navigate to="/app" replace />;
  const row = slug ? rows.data?.find((candidate) => candidate.slug === slug) : null;
  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <WindowChrome />
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-8">
          {row !== undefined ? (
            <AdminBotListingForm row={row} />
          ) : rows.isPending ? (
            <div className="grid place-items-center py-10">
              <Spinner className="size-5 text-muted-foreground" />
            </div>
          ) : (
            <p role="alert" className="text-body text-destructive">
              <Trans>That listing no longer exists.</Trans>
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
