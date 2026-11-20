import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, MarketplaceBotCatalogEntry } from "@rakazo/contracts";
import { isBotMarketplaceChanged } from "@rakazo/contracts";
import { matchConnectedAppCatalog } from "@rakazo/core";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  ListSearchInput,
  SectionHeading,
  Spinner,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, LayoutTemplate, X } from "lucide-react";
import { useState } from "react";
import { useSpaceQueries } from "../../lib/query/query";
import { rpc } from "../../lib/query/rpc";
import type { ErrorDetails } from "../../lib/query/user-error";
import { errorDetails } from "../../lib/query/user-error";
import { ErrorNotice } from "../ErrorNotice";
import { ROW_HOVER } from "../integrations/plugin-marketplace";
import { BotMarketplaceDetail } from "./bot-marketplace-detail";

const CATEGORIES = ["personal", "engineering", "sales", "operations"] as const;
type Category = (typeof CATEGORIES)[number];

function MarketIcon({ large = false }: { large?: boolean }) {
  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center border border-border/60 bg-muted text-foreground ${
        large ? "h-14 w-14 rounded-2xl" : "h-10 w-10 rounded-xl"
      }`}
    >
      <LayoutTemplate size={large ? 24 : 18} />
    </span>
  );
}

/** The bot market: browse published bots, preview one, add it as your own inert copy. */
export function BotMarketplaceDialog({
  onClose,
  onOpenBot,
}: {
  onClose: () => void;
  onOpenBot: (bot: Bot) => void;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  // Read afresh each time it opens: a bot may have been added or published since.
  const catalog = useQuery({
    ...queries.botMarketplace.catalog.queryOptions({ input: {} }),
    staleTime: 0,
  });
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<"all" | Category>("all");
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ErrorDetails | null>(null);
  const detail = useQuery({
    ...queries.botMarketplace.get.queryOptions({ input: { slug: openSlug ?? "" } }),
    enabled: openSlug !== null,
    staleTime: 0,
  });
  const appCatalog = useQuery({
    ...queries.connections.catalog.queryOptions({ input: {} }),
    enabled: openSlug !== null && (detail.data?.listing.apps.length ?? 0) > 0,
  });
  const appNames = Object.fromEntries(
    (detail.data?.listing.apps ?? []).flatMap((slug) => {
      const item = matchConnectedAppCatalog(appCatalog.data ?? [], slug);
      return item ? [[slug, item.name]] : [];
    }),
  );

  const labels: Record<Category, string> = {
    personal: t`Personal`,
    engineering: t`Engineering`,
    sales: t`Sales`,
    operations: t`Operations`,
  };
  const entries = catalog.data?.entries ?? [];
  const needle = query.trim().toLowerCase();
  const filtering = category !== "all" || needle !== "";
  const matched = entries.filter(
    (entry) =>
      (category === "all" || entry.category === category) &&
      (!needle || `${entry.name} ${entry.tagline}`.toLowerCase().includes(needle)),
  );
  const featured = entries.filter((entry) => entry.featured);

  async function add(slug: string, version: number) {
    setPending(true);
    setError(null);
    try {
      const { bot } = await rpc.botMarketplace.install({ slug, version });
      onOpenBot(bot);
    } catch (err) {
      const changed = isBotMarketplaceChanged(err);
      setError(
        errorDetails(
          changed ? t`This bot was just updated. Check it again.` : err,
          t`Could not add the bot`,
        ),
      );
      if (changed) {
        void catalog.refetch();
        void detail.refetch();
      }
      setPending(false);
    }
  }

  async function openExisting(botId: string) {
    setPending(true);
    try {
      const bot = await rpc.bots.get({ botId });
      onOpenBot(bot);
    } catch (err) {
      setError(errorDetails(err, t`Could not open the bot`));
      setPending(false);
    }
  }

  function row(entry: MarketplaceBotCatalogEntry) {
    return (
      <div key={entry.slug} className={`flex items-center gap-3 rounded-xl px-2 py-2 ${ROW_HOVER}`}>
        <button
          type="button"
          data-testid="market-row"
          onClick={() => {
            setError(null);
            setOpenSlug(entry.slug);
          }}
          className="flex min-w-0 flex-1 items-center gap-3 text-start focus-visible:outline-none"
        >
          <MarketIcon />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-body-lg font-medium text-foreground">
              {entry.name}
            </span>
            <span className="line-clamp-2 text-body-sm text-muted-foreground">{entry.tagline}</span>
          </span>
        </button>
        {entry.botId ? (
          <Button
            variant="ghost"
            size="sm"
            className="rounded-full"
            disabled={pending}
            onClick={() => void openExisting(entry.botId!)}
          >
            <Trans>Added</Trans>
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="rounded-full"
            disabled={pending}
            onClick={() => void add(entry.slug, entry.version)}
          >
            <Trans>Add</Trans>
          </Button>
        )}
      </div>
    );
  }

  function browse() {
    if (catalog.error)
      return (
        <ErrorNotice error={errorDetails(catalog.error, t`Could not load the market`)}>
          <Button variant="outline" size="sm" onClick={() => void catalog.refetch()}>
            <Trans>Retry</Trans>
          </Button>
        </ErrorNotice>
      );
    if (!catalog.data)
      return (
        <div className="grid place-items-center py-10">
          <Spinner className="size-5 text-muted-foreground" aria-label={t`Loading…`} />
        </div>
      );
    return (
      <div className="space-y-6">
        <ListSearchInput
          query={query}
          setQuery={setQuery}
          label={t`Search bots`}
          placeholder={t`Search bots`}
        />
        <fieldset className="m-0 flex flex-wrap gap-2 border-0 p-0" aria-label={t`Categories`}>
          {(["all", ...CATEGORIES] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={category === value}
              onClick={() => setCategory(value)}
              className={`rounded-full px-3.5 py-1.5 text-body-sm focus-visible:outline-none ${
                category === value
                  ? "bg-primary font-medium text-primary-foreground"
                  : "bg-muted text-foreground hover:bg-accent"
              }`}
            >
              {value === "all" ? <Trans>All</Trans> : labels[value]}
            </button>
          ))}
        </fieldset>
        {!filtering && featured.length > 0 ? (
          <section className="space-y-2">
            <SectionHeading className="px-1">
              <Trans>Featured</Trans>
            </SectionHeading>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {featured.map((entry) => (
                <button
                  key={entry.slug}
                  type="button"
                  data-testid="market-featured-card"
                  onClick={() => {
                    setError(null);
                    setOpenSlug(entry.slug);
                  }}
                  className={`flex flex-col items-center gap-3 rounded-2xl border border-border/70 px-3 py-6 text-center focus-visible:outline-none ${ROW_HOVER}`}
                >
                  <MarketIcon large />
                  <span className="line-clamp-2 text-body font-medium text-foreground">
                    {entry.name}
                  </span>
                </button>
              ))}
            </div>
          </section>
        ) : null}
        {matched.length === 0 ? (
          <div className="space-y-3 py-10 text-center text-body text-muted-foreground">
            <p>
              <Trans>No bots found.</Trans>
            </p>
            {filtering ? (
              <Button
                variant="link"
                size="sm"
                onClick={() => {
                  setQuery("");
                  setCategory("all");
                }}
              >
                <Trans>Clear filters</Trans>
              </Button>
            ) : null}
          </div>
        ) : (
          CATEGORIES.filter((value) => matched.some((entry) => entry.category === value)).map(
            (value) => (
              <section key={value} className="space-y-2">
                <SectionHeading className="px-1">{labels[value]}</SectionHeading>
                <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                  {matched.filter((entry) => entry.category === value).map(row)}
                </div>
              </section>
            ),
          )
        )}
      </div>
    );
  }

  function detailView() {
    if (detail.error)
      return (
        <ErrorNotice error={errorDetails(detail.error, t`Could not load the bot`)}>
          <Button variant="outline" size="sm" onClick={() => void detail.refetch()}>
            <Trans>Retry</Trans>
          </Button>
        </ErrorNotice>
      );
    if (!detail.data)
      return (
        <div className="grid place-items-center py-10">
          <Spinner className="size-5 text-muted-foreground" aria-label={t`Loading…`} />
        </div>
      );
    const { listing, botId } = detail.data;
    return (
      <div className="space-y-4">
        <Button
          variant="ghost"
          size="icon-sm"
          className="-ms-2 text-muted-foreground"
          aria-label={t`Back to the market`}
          disabled={pending}
          onClick={() => {
            setError(null);
            setOpenSlug(null);
          }}
        >
          <ChevronLeft />
        </Button>
        {error ? <ErrorNotice error={error} /> : null}
        <BotMarketplaceDetail
          listing={listing}
          botId={botId}
          busy={pending}
          appNames={appNames}
          onAdd={() => void add(listing.id, listing.version)}
          onOpen={botId ? () => void openExisting(botId) : undefined}
        />
      </div>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        data-testid="bot-marketplace-dialog"
        size="lg"
        className="bg-card"
      >
        <DialogHeader className="flex-row items-start justify-between px-8 pt-7">
          <DialogTitle className="text-heading2 text-foreground">
            <Trans>Bot market</Trans>
          </DialogTitle>
          <DialogClose
            render={<Button variant="ghost" size="icon-sm" aria-label={t`Close the market`} />}
          >
            <X />
          </DialogClose>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-8 pt-5 pb-8">
          {openSlug ? detailView() : browse()}
        </div>
      </DialogContent>
    </Dialog>
  );
}
