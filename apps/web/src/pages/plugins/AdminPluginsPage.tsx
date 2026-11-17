import { Trans, useLingui } from "@lingui/react/macro";
import { buttonVariants } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import { Link, Navigate } from "react-router-dom";
import { PageLoading } from "../../components/PageLoading";
import { WindowChrome } from "../../components/WindowChrome";
import { useSpaceQueries } from "../../lib/query/query";
import { PluginSubmissionsPanel } from "./PluginSubmissionsPanel";

export function AdminPluginsPage() {
  const { t } = useLingui();
  const me = useQuery(useSpaceQueries().me.queryOptions());
  if (me.isPending) return <PageLoading />;
  if (!me.data?.isAdmin) return <Navigate to="/app" replace />;
  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <WindowChrome />
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <Link
          to="/app"
          className={buttonVariants({ variant: "ghost", size: "icon" })}
          aria-label={t`Back`}
        >
          <ChevronLeft />
        </Link>
        <h1 className="flex-1 font-medium">
          <Trans>Plugin submissions</Trans>
        </h1>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-6">
          <PluginSubmissionsPanel />
        </div>
      </main>
    </div>
  );
}
