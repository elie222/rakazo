import { Trans, useLingui } from "@lingui/react/macro";
import type { MarketplaceBotStatus } from "@rakazo/contracts";
import { Badge, Button, Spinner, Tabs, TabsList, TabsTrigger, toast } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { Star } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSave, useSpaceQueries } from "../lib/query/query";
import { errorText } from "../lib/query/user-error";

type StatusTab = "all" | MarketplaceBotStatus;

/** The ops console: maintain the catalog online — draft, edit, publish, feature, sort. */
export function AdminBotsPanel() {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const [tab, setTab] = useState<StatusTab>("all");
  const navigate = useNavigate();
  const rows = useQuery(
    queries.botMarketplace.admin.list.queryOptions({
      input: tab === "all" ? {} : { status: tab },
    }),
  );
  const change = useSave({
    save: (
      input:
        | { slug: string; featured: boolean }
        | { slug: string; status: "published" | "unpublished" },
      client,
    ) =>
      "status" in input
        ? client.botMarketplace.admin.setStatus(input)
        : client.botMarketplace.admin.update(input),
    stale: [queries.botMarketplace.admin.list.key()],
    onFailed: (error) => toast.error(errorText(error, t`Could not update the bot`)),
  });
  const pending = change.pending ? change.input?.slug : undefined;

  const list = rows.data ?? [];

  return (
    <div data-testid="admin-bots" className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={tab} onValueChange={(value) => setTab(value as StatusTab)}>
          <TabsList>
            <TabsTrigger value="all" className="px-3">
              <Trans>All</Trans>
            </TabsTrigger>
            <TabsTrigger value="draft" className="px-3">
              <Trans>Drafts</Trans>
            </TabsTrigger>
            <TabsTrigger value="published" className="px-3">
              <Trans>Published</Trans>
            </TabsTrigger>
            <TabsTrigger value="unpublished" className="px-3">
              <Trans>Unpublished</Trans>
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <Button onClick={() => navigate("/admin/bots/new")}>
          <Trans>New bot</Trans>
        </Button>
      </div>

      {rows.isPending ? (
        <div className="grid place-items-center py-10">
          <Spinner className="size-5 text-muted-foreground" aria-label={t`Loading…`} />
        </div>
      ) : rows.isError ? (
        <div role="alert" className="flex items-center gap-3 text-body text-destructive">
          {errorText(rows.error, t`Couldn't load the catalog`)}
          <Button variant="outline" size="sm" onClick={() => void rows.refetch()}>
            <Trans>Retry</Trans>
          </Button>
        </div>
      ) : list.length === 0 ? (
        <p className="py-10 text-center text-body text-muted-foreground">
          <Trans>No bots here yet.</Trans>
        </p>
      ) : (
        <ul className="divide-y divide-border/60 rounded-xl border border-border/70">
          {list.map((row) => (
            <li key={row.slug} className="flex items-center gap-3 px-4 py-3">
              <button
                type="button"
                className={`shrink-0 rounded-md p-1 focus-visible:outline-none ${
                  row.featured ? "text-foreground" : "text-muted-foreground/50"
                }`}
                aria-label={t`Featured`}
                aria-pressed={row.featured}
                disabled={pending === row.slug}
                onClick={() => change.run({ slug: row.slug, featured: !row.featured })}
              >
                <Star size={16} fill={row.featured ? "currentColor" : "none"} />
              </button>
              <div className="min-w-0 flex-1">
                <p className="truncate text-body-lg font-medium text-foreground">
                  {row.listing.name}
                </p>
                <p className="truncate text-body-sm text-muted-foreground">
                  {row.slug} · v{row.version} · {row.listing.category}
                </p>
              </div>
              <Badge variant={row.status === "published" ? "secondary" : "outline"}>
                {row.status === "published" ? (
                  <Trans>Published</Trans>
                ) : row.status === "draft" ? (
                  <Trans>Draft</Trans>
                ) : (
                  <Trans>Unpublished</Trans>
                )}
              </Badge>
              <Button variant="ghost" size="sm" onClick={() => navigate(`/admin/bots/${row.slug}`)}>
                <Trans>Edit</Trans>
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={pending === row.slug}
                onClick={() =>
                  change.run({
                    slug: row.slug,
                    status: row.status === "published" ? "unpublished" : "published",
                  })
                }
              >
                {row.status === "published" ? <Trans>Unpublish</Trans> : <Trans>Publish</Trans>}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
