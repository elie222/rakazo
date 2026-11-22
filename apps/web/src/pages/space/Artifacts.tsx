import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { Artifact, Bot } from "@rakazo/contracts";
import { artifactTypeLabel } from "@rakazo/core";
import { writeSaved } from "@rakazo/core/query";
import {
  BotAvatar,
  Button,
  buttonVariants,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  ListSearchInput,
  OptionSelect,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  ToggleGroup,
  ToggleGroupItem,
} from "@rakazo/ui-web";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft,
  FileCode2,
  FileText,
  ImageIcon,
  LayoutGrid,
  List,
  Search,
  SearchX,
  Trash2,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { IconTooltip } from "../../components/IconTooltip";
import { WindowChrome } from "../../components/WindowChrome";
import { takeInitialBootstrap } from "../../lib/bootstrap";
import { formatRelativeTime } from "../../lib/locale/relative-time";
import { desktopBridge } from "../../lib/platform/desktop";
import { createStoredPreference } from "../../lib/preferences/stored-preference";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { errorText } from "../../lib/query/user-error";
import { useAppRail } from "../shell/app-rail";
import { useRedrawAtMidnight } from "../shell/chat/use-redraw-at-midnight";
import { ArtifactMimeIcon } from "./artifact-mime-icon";
import { PreviewPane } from "./artifact-preview-pane";

type ViewMode = "grid" | "list";
type DateFilter = "all" | "today" | "week" | "month";
const viewModePreference = createStoredPreference<ViewMode>({
  key: "rakazo:artifacts-view-mode",
  parse: (raw) => (raw === "list" ? "list" : "grid"),
  serialize: (mode) => mode,
});
const LIST_PAGE_SIZE = 60;

type ArtifactSummary = Artifact & { versionCount: number };

const NO_BOTS: Bot[] = [];

// Older browsers without locale week data still need the week start of each app language.
const MONDAY_FIRST_LOCALES = new Set(["de", "es", "fr", "nl", "pl", "ru", "tr", "zh-CN"]);

function firstDayOfWeek(locale: string): number {
  const regional = new Intl.Locale(locale || "en") as Intl.Locale & {
    getWeekInfo?: () => { firstDay: number };
    weekInfo?: { firstDay: number };
  };
  const firstDay = (regional.getWeekInfo?.() ?? regional.weekInfo)?.firstDay;
  // Intl uses 7 for Sunday; Date.getDay() uses 0.
  return firstDay === undefined
    ? MONDAY_FIRST_LOCALES.has(regional.baseName)
      ? 1
      : 0
    : firstDay % 7;
}

function matchesCalendarDateFilter(
  iso: string,
  filter: DateFilter,
  now: Date,
  weekStartsOn: number,
): boolean {
  if (filter === "all") return true;
  const date = new Date(iso);
  if (filter === "today") return date.toDateString() === now.toDateString();
  if (filter === "week") {
    const startOfWeek = new Date(now);
    startOfWeek.setHours(0, 0, 0, 0);
    const daysSinceStart = (startOfWeek.getDay() - weekStartsOn + 7) % 7;
    startOfWeek.setDate(startOfWeek.getDate() - daysSinceStart);
    return date >= startOfWeek;
  }
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
}

export function ArtifactsPage() {
  const rail = useAppRail();
  const { artifactId } = useParams<{ artifactId?: string }>();
  const navigate = useNavigate();
  const today = useRedrawAtMidnight();
  const { t } = useLingui();
  // The bot filter is part of the URL, so a link to a bot's files keeps it after a reload.
  const [searchParams, setSearchParams] = useSearchParams();
  function setActiveBotId(botId: string | null) {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (botId) next.set("bot", botId);
        else next.delete("bot");
        return next;
      },
      { replace: true },
    );
  }
  const viewMode = viewModePreference.use();
  const [searchQuery, setSearchQuery] = useState("");
  const [dateFilter, setDateFilter] = useState<DateFilter>("all");
  const [madeByBots, setMadeByBots] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ArtifactSummary | null>(null);

  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  // The space's bootstrap is where the shell keeps what it last loaded, bots included.
  const botsQuery = useQuery({
    queryKey: queries.bootstrap.queryKey({ input: {} }),
    queryFn: () => takeInitialBootstrap(),
    select: (bootstrap) => bootstrap.bots,
  });
  const bots = botsQuery.data ?? NO_BOTS;
  // A saved link naming a bot that no longer exists reads as all bots, not as a refused listing.
  const requestedBotId = searchParams.get("bot");
  const activeBotId =
    requestedBotId && botsQuery.isSuccess && !bots.some((bot) => bot.id === requestedBotId)
      ? null
      : requestedBotId;
  const botQuery = activeBotId ? `?bot=${activeBotId}` : "";
  const listingOptions = queries.artifacts.listSpace.infiniteOptions({
    input: (cursor: string | undefined) => ({
      botId: activeBotId ?? undefined,
      madeByBots,
      ...(cursor ? { cursor } : {}),
      limit: LIST_PAGE_SIZE,
    }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const listing = useInfiniteQuery(listingOptions);
  const items = useMemo(
    () => listing.data?.pages.flatMap((page) => page.items) ?? null,
    [listing.data],
  );
  const nextCursor = listing.data?.pages.at(-1)?.nextCursor ?? null;
  const loadingMore = listing.isFetchingNextPage;
  const loadError =
    listing.error && !listing.data ? errorText(listing.error, t`Could not load artifacts.`) : null;
  // A failed refresh over the cached list is still said; a failed next page keeps Load more.
  const refreshError =
    listing.data && listing.isRefetchError
      ? errorText(listing.error, t`Could not load artifacts.`)
      : null;

  function loadMore() {
    // A failed page keeps what is shown so Load more can be retried.
    if (nextCursor && !listing.isFetchingNextPage) void listing.fetchNextPage();
  }

  useEffect(() => {
    setMaximized(false);
  }, [artifactId]);

  const botsById = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);

  const { i18n } = useLingui();
  const locale = i18n.locale;
  const filteredItems = useMemo(() => {
    if (!items) return null;
    const now = new Date();
    const weekStartsOn = dateFilter === "week" ? firstDayOfWeek(locale) : 0;
    const query = searchQuery.trim().toLowerCase();
    return items.filter((item) => {
      if (!matchesCalendarDateFilter(item.createdAt, dateFilter, now, weekStartsOn)) return false;
      if (!query) return true;
      return (
        item.name.toLowerCase().includes(query) ||
        (item.description?.toLowerCase().includes(query) ?? false)
      );
    });
    // `today` is listed so the midnight tick invalidates cached date filters.
  }, [items, searchQuery, dateFilter, today, locale]);

  const clientFilterActive = searchQuery.trim().length > 0 || dateFilter !== "all";
  const autoFetchedCursorRef = useRef<string | null>(null);

  useEffect(() => {
    autoFetchedCursorRef.current = null;
  }, [searchQuery, dateFilter, activeBotId, madeByBots]);

  // Search and date filters only see loaded pages, so keep paging until something matches.
  useEffect(() => {
    if (!clientFilterActive || !nextCursor || loadingMore || items === null) return;
    if (filteredItems && filteredItems.length > 0) return;
    if (autoFetchedCursorRef.current === nextCursor) return;
    autoFetchedCursorRef.current = nextCursor;
    void loadMore();
  }, [clientFilterActive, nextCursor, loadingMore, items, filteredItems]);

  const remove = useSave({
    save: async (artifact: ArtifactSummary, rpc) => {
      await rpc.artifacts.remove({ artifactId: artifact.id });
      // Gone from this list at once, even when reading it again fails.
      await writeSaved(queryClient, listingOptions.queryKey, (current) => ({
        pages: (current?.pages ?? []).map((page) => ({
          ...page,
          items: page.items.filter((item) => item.id !== artifact.id),
        })),
        pageParams: current?.pageParams ?? [],
      }));
    },
    // Listings for other bots may hold it too.
    stale: [queries.artifacts.listSpace.key()],
    onSaved: (_removed, artifact) => {
      if (artifactId === artifact.id) navigate(`/app/artifacts${botQuery}`);
      setPendingDelete(null);
    },
  });

  const serverFilterActive = activeBotId !== null || madeByBots;
  const filtersActive = serverFilterActive || clientFilterActive;
  // Nothing to narrow down yet, so the page stays a clean empty state.
  const showFilters = serverFilterActive || (items !== null && (items.length > 0 || !!nextCursor));

  function clearFilters() {
    setSearchQuery("");
    setDateFilter("all");
    setActiveBotId(null);
    setMadeByBots(false);
  }

  const emptyState = (
    <EmptyArtifacts
      filtered={filtersActive}
      onClearFilters={clearFilters}
      nextCursor={nextCursor}
      loadingMore={loadingMore}
      onLoadMore={loadMore}
    />
  );

  return (
    <div className="flex h-full min-w-0 flex-col bg-background text-foreground/90">
      <header className="app-drag flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3">
        {/* This route is the window's leading edge, so Electron window controls sit in the header. */}
        {desktopBridge() ? <WindowChrome className={rail ? "md:hidden" : undefined} /> : null}
        <div className="flex min-w-fit flex-1 items-center gap-1">
          <IconTooltip label={t`Back`}>
            <Link
              to="/app"
              aria-label={t`Back`}
              className={buttonVariants({
                variant: "ghost",
                size: "icon",
                className: "app-no-drag text-muted-foreground",
              })}
            >
              <ChevronLeft />
            </Link>
          </IconTooltip>
          <h1 className="font-medium text-foreground">
            <Trans>Artifacts</Trans>
          </h1>
        </div>
        {showFilters ? (
          <div className="app-no-drag flex flex-wrap items-center gap-2">
            <SearchToggle query={searchQuery} onQueryChange={setSearchQuery} />
            {bots.length > 1 || activeBotId ? (
              <BotFilter bots={bots} value={activeBotId} onValueChange={setActiveBotId} />
            ) : null}
            <OptionSelect
              aria-label={t`Filter by date`}
              className="w-fit"
              value={dateFilter}
              onValueChange={setDateFilter}
              options={[
                { value: "all", label: t`All time` },
                { value: "today", label: t`Today` },
                { value: "week", label: t`This week` },
                { value: "month", label: t`This month` },
              ]}
            />
            <OptionSelect
              aria-label={t`Filter by who made it`}
              className="w-fit"
              value={madeByBots ? "bots" : "all"}
              onValueChange={(value) => setMadeByBots(value === "bots")}
              options={[
                { value: "all", label: t`All files` },
                { value: "bots", label: t`Made by bots` },
              ]}
            />
            {!artifactId ? (
              <ToggleGroup
                value={[viewMode]}
                onValueChange={([next]) => {
                  if (next) viewModePreference.set(next as ViewMode);
                }}
                spacing={1}
                className="h-8 rounded-lg border border-input p-0.5"
              >
                <IconTooltip label={t`Card view`}>
                  <ToggleGroupItem
                    value="grid"
                    aria-label={t`Card view`}
                    className="aspect-square h-full w-auto min-w-0 rounded-md px-0 text-muted-foreground aria-pressed:bg-accent aria-pressed:text-accent-foreground"
                  >
                    <LayoutGrid className="size-3.5" />
                  </ToggleGroupItem>
                </IconTooltip>
                <IconTooltip label={t`List view`}>
                  <ToggleGroupItem
                    value="list"
                    aria-label={t`List view`}
                    className="aspect-square h-full w-auto min-w-0 rounded-md px-0 text-muted-foreground aria-pressed:bg-accent aria-pressed:text-accent-foreground"
                  >
                    <List className="size-3.5" />
                  </ToggleGroupItem>
                </IconTooltip>
              </ToggleGroup>
            ) : null}
          </div>
        ) : null}
      </header>

      {refreshError ? (
        <p role="alert" className="px-6 py-2 text-body text-destructive">
          {refreshError}
        </p>
      ) : null}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {artifactId ? (
          <>
            {!maximized ? (
              <IndexPane
                items={filteredItems}
                loadError={loadError}
                botsById={botsById}
                selectedId={artifactId}
                botQuery={botQuery}
                onRequestDelete={setPendingDelete}
                nextCursor={nextCursor}
                loadingMore={loadingMore}
                onLoadMore={loadMore}
                empty={emptyState}
              />
            ) : null}
            <PreviewPane
              key={artifactId}
              artifactId={artifactId}
              maximized={maximized}
              onToggleMaximize={() => setMaximized((value) => !value)}
            />
          </>
        ) : (
          <BrowsingPane
            items={filteredItems}
            loadError={loadError}
            viewMode={viewMode}
            botsById={botsById}
            botQuery={botQuery}
            onRequestDelete={setPendingDelete}
            nextCursor={nextCursor}
            loadingMore={loadingMore}
            onLoadMore={loadMore}
            empty={emptyState}
          />
        )}
      </div>

      {pendingDelete ? (
        <ConfirmDialog
          onCancel={() => {
            setPendingDelete(null);
            remove.reset();
          }}
          title={<Trans>Delete "{pendingDelete.name}"?</Trans>}
          description={
            pendingDelete.versionCount > 1 ? (
              <Trans>
                This deletes all {pendingDelete.versionCount} versions of this artifact. This can't
                be undone.
              </Trans>
            ) : (
              <Trans>This can't be undone.</Trans>
            )
          }
          error={remove.error ? errorText(remove.error, t`Could not delete this artifact.`) : null}
          busy={remove.pending}
          onConfirm={() => remove.run(pendingDelete)}
          confirmLabel={remove.pending ? <Trans>Deleting…</Trans> : <Trans>Delete</Trans>}
        />
      ) : null}
    </div>
  );
}

function BrowsingPane({
  items,
  loadError,
  viewMode,
  botsById,
  botQuery,
  onRequestDelete,
  nextCursor,
  loadingMore,
  onLoadMore,
  empty,
}: {
  items: ArtifactSummary[] | null;
  loadError: string | null;
  viewMode: ViewMode;
  botsById: Map<string, Bot>;
  botQuery: string;
  onRequestDelete: (artifact: ArtifactSummary) => void;
  nextCursor: string | null;
  loadingMore: boolean;
  onLoadMore: () => void;
  empty: ReactNode;
}) {
  if (items === null) {
    return (
      <div className="grid flex-1 place-items-center text-body text-muted-foreground/80">
        {loadError ?? <Spinner aria-label={t`Loading…`} />}
      </div>
    );
  }
  if (items.length === 0) return empty;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
      {viewMode === "grid" ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
          {items.map((item) => (
            <ArtifactCard
              key={item.id}
              artifact={item}
              bot={item.botId ? botsById.get(item.botId) : undefined}
              botQuery={botQuery}
              onRequestDelete={onRequestDelete}
            />
          ))}
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border">
          {items.map((item) => (
            <ArtifactRow
              key={item.id}
              artifact={item}
              bot={item.botId ? botsById.get(item.botId) : undefined}
              botQuery={botQuery}
              onRequestDelete={onRequestDelete}
            />
          ))}
        </div>
      )}
      {nextCursor ? <LoadMoreButton loading={loadingMore} onClick={onLoadMore} /> : null}
    </div>
  );
}

function LoadMoreButton({ loading, onClick }: { loading: boolean; onClick: () => void }) {
  return (
    <div className="mt-4 flex justify-center">
      <Button
        variant="outline"
        size="sm"
        disabled={loading}
        onClick={onClick}
        aria-label={t`Load more`}
      >
        {loading ? <Spinner aria-label={t`Loading…`} /> : null}
        <Trans>Load more</Trans>
      </Button>
    </div>
  );
}

function EmptyArtifacts({
  filtered,
  onClearFilters,
  nextCursor,
  loadingMore,
  onLoadMore,
}: {
  filtered: boolean;
  onClearFilters: () => void;
  nextCursor: string | null;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  if (nextCursor) {
    return (
      <Empty>
        {loadingMore ? (
          <Spinner aria-label={t`Loading…`} />
        ) : (
          <EmptyDescription>
            <Trans>No matching artifacts on this page.</Trans>
          </EmptyDescription>
        )}
        <LoadMoreButton loading={loadingMore} onClick={onLoadMore} />
      </Empty>
    );
  }
  if (filtered) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SearchX />
          </EmptyMedia>
          <EmptyTitle>
            <Trans>No matching artifacts</Trans>
          </EmptyTitle>
        </EmptyHeader>
        <Button variant="outline" onClick={onClearFilters}>
          <Trans>Clear filters</Trans>
        </Button>
      </Empty>
    );
  }
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia>
          <ArtifactStackArt />
        </EmptyMedia>
        <EmptyTitle>
          <Trans>No artifacts yet</Trans>
        </EmptyTitle>
        <EmptyDescription>
          <Trans>Files your bots create, like reports, docs and images, collect here.</Trans>
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function ArtifactStackArt() {
  const sheet =
    "absolute bottom-0 flex h-20 w-16 flex-col rounded-xl border border-border bg-card shadow-sm";
  return (
    <div aria-hidden="true" className="relative h-24 w-44">
      <div
        className={`${sheet} start-3 origin-bottom -rotate-10 items-start justify-center ps-3 text-muted-foreground`}
      >
        <ImageIcon className="size-5" strokeWidth={1.6} />
      </div>
      <div
        className={`${sheet} end-3 origin-bottom rotate-10 items-end justify-center pe-3 text-muted-foreground`}
      >
        <FileCode2 className="size-5" strokeWidth={1.6} />
      </div>
      <div className={`${sheet} inset-x-0 mx-auto h-22 w-17 gap-1.5 p-2.5 shadow-md`}>
        <FileText className="mb-1 size-4 text-foreground/80" strokeWidth={1.8} />
        <span className="h-1 w-full rounded-full bg-muted-foreground/25" />
        <span className="h-1 w-4/5 rounded-full bg-muted-foreground/25" />
        <span className="h-1 w-full rounded-full bg-muted-foreground/25" />
        <span className="h-1 w-3/5 rounded-full bg-muted-foreground/25" />
      </div>
    </div>
  );
}

function SearchToggle({
  query,
  onQueryChange,
}: {
  query: string;
  onQueryChange: (query: string) => void;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(query.length > 0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!query && document.activeElement !== inputRef.current) setOpen(false);
  }, [query]);

  if (!open && !query) {
    return (
      <IconTooltip label={t`Search`}>
        <Button
          variant="outline"
          size="icon"
          aria-label={t`Search`}
          className="text-muted-foreground"
          onClick={() => setOpen(true)}
        >
          <Search />
        </Button>
      </IconTooltip>
    );
  }
  return (
    <search
      className="w-56 max-w-full animate-in fade-in-0 slide-in-from-right-2 duration-150"
      onBlur={() => {
        if (!query.trim()) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        onQueryChange("");
        setOpen(false);
      }}
    >
      <ListSearchInput
        query={query}
        setQuery={onQueryChange}
        label={t`Search artifacts`}
        placeholder={t`Search artifacts…`}
        inputRef={inputRef}
      />
    </search>
  );
}

const ALL_BOTS = "all";

function BotFilter({
  bots,
  value,
  onValueChange,
}: {
  bots: Bot[];
  value: string | null;
  onValueChange: (botId: string | null) => void;
}) {
  const { t } = useLingui();
  const botsById = new Map(bots.map((bot) => [bot.id, bot]));
  return (
    <Select
      value={value ?? ALL_BOTS}
      onValueChange={(next) => onValueChange(next === ALL_BOTS || !next ? null : next)}
    >
      <SelectTrigger aria-label={t`Filter by bot`} className="max-w-44">
        <SelectValue>
          {(selected: string) => {
            const bot = botsById.get(selected);
            return bot ? <BotOption bot={bot} /> : t`All bots`;
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value={ALL_BOTS}>{t`All bots`}</SelectItem>
          {bots.map((bot) => (
            <SelectItem key={bot.id} value={bot.id}>
              <BotOption bot={bot} />
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function BotOption({ bot }: { bot: Bot }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <BotAvatar
        avatarSet={bot.avatarSet}
        color={bot.color}
        identity={bot.id}
        size={16}
        status={bot.status}
      />
      <span className="truncate">{bot.name}</span>
    </span>
  );
}

function IndexPane({
  items,
  loadError,
  botsById,
  selectedId,
  botQuery,
  onRequestDelete,
  nextCursor,
  loadingMore,
  onLoadMore,
  empty,
}: {
  items: ArtifactSummary[] | null;
  loadError: string | null;
  botsById: Map<string, Bot>;
  selectedId: string;
  botQuery: string;
  onRequestDelete: (artifact: ArtifactSummary) => void;
  nextCursor: string | null;
  loadingMore: boolean;
  onLoadMore: () => void;
  empty: ReactNode;
}) {
  return (
    <aside className="flex w-[320px] shrink-0 flex-col overflow-y-auto border-e border-border">
      {items === null ? (
        <div className="grid flex-1 place-items-center p-6 text-center text-body text-muted-foreground/80">
          {loadError ?? <Spinner aria-label={t`Loading…`} />}
        </div>
      ) : items.length === 0 ? (
        empty
      ) : (
        <div className="flex flex-col divide-y divide-border">
          {items.map((item) => (
            <ArtifactRow
              key={item.id}
              artifact={item}
              bot={item.botId ? botsById.get(item.botId) : undefined}
              active={item.id === selectedId}
              botQuery={botQuery}
              onRequestDelete={onRequestDelete}
            />
          ))}
          {nextCursor ? (
            <div className="p-3">
              <LoadMoreButton loading={loadingMore} onClick={onLoadMore} />
            </div>
          ) : null}
        </div>
      )}
    </aside>
  );
}

function ArtifactCard({
  artifact,
  bot,
  botQuery,
  onRequestDelete,
}: {
  artifact: ArtifactSummary;
  bot: Bot | undefined;
  botQuery: string;
  onRequestDelete: (artifact: ArtifactSummary) => void;
}) {
  const { t } = useLingui();
  return (
    <div className="group relative">
      <Link
        to={`/app/artifacts/${artifact.id}${botQuery}`}
        className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 text-foreground shadow-control hover:bg-accent/40"
      >
        <div className="flex items-start justify-between">
          <span className="grid h-9 w-9 place-items-center rounded-md bg-accent text-accent-foreground">
            <ArtifactMimeIcon mimeType={artifact.mimeType} />
          </span>
          <div className="flex items-center gap-1.5">
            {artifact.versionCount > 1 ? (
              <span className="rounded-md bg-muted px-2 py-1 text-caption font-semibold text-muted-foreground">
                {`v${artifact.version}`}
              </span>
            ) : null}
            <span className="rounded-md bg-muted px-2 py-1 text-caption font-semibold text-muted-foreground">
              {artifactTypeLabel(artifact.mimeType)}
            </span>
          </div>
        </div>
        <div className="min-w-0">
          <div className="truncate text-body-lg font-semibold">{artifact.name}</div>
          {artifact.description ? (
            <div className="mt-1 line-clamp-2 text-body-sm leading-relaxed text-muted-foreground">
              {artifact.description}
            </div>
          ) : null}
        </div>
        <div className="mt-auto flex items-center gap-2 text-label text-muted-foreground">
          {bot ? (
            <>
              <BotAvatar
                avatarSet={bot.avatarSet}
                color={bot.color}
                identity={bot.id}
                size={20}
                status={bot.status}
              />
              <span className="min-w-0 flex-1 truncate">{bot.name}</span>
            </>
          ) : (
            <span className="flex-1" />
          )}
          <span className="shrink-0">{formatRelativeTime(artifact.createdAt)}</span>
        </div>
      </Link>
      <IconTooltip label={t`Delete ${artifact.name}`}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t`Delete ${artifact.name}`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onRequestDelete(artifact);
          }}
          className="absolute bottom-3 end-3 bg-card text-muted-foreground opacity-0 hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 group-focus-within:opacity-100"
        >
          <Trash2 strokeWidth={1.9} />
        </Button>
      </IconTooltip>
    </div>
  );
}

function ArtifactRow({
  artifact,
  bot,
  active,
  botQuery,
  onRequestDelete,
}: {
  artifact: ArtifactSummary;
  bot: Bot | undefined;
  active?: boolean;
  botQuery: string;
  onRequestDelete: (artifact: ArtifactSummary) => void;
}) {
  const { t } = useLingui();
  return (
    <div className={`group relative ${active ? "bg-accent/60" : "hover:bg-accent/40"}`}>
      <Link
        to={`/app/artifacts/${artifact.id}${botQuery}`}
        className="flex flex-col gap-1 px-4 py-3 pe-10"
      >
        <div className="flex items-center gap-2">
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-[7px] bg-accent text-accent-foreground">
            <ArtifactMimeIcon mimeType={artifact.mimeType} small />
          </span>
          <span className="min-w-0 flex-1 truncate text-body font-medium">{artifact.name}</span>
          {artifact.versionCount > 1 ? (
            <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-caption font-semibold text-muted-foreground">
              {`v${artifact.version}`}
            </span>
          ) : null}
        </div>
        {artifact.description ? (
          <div className="ps-8 text-body-sm leading-snug text-muted-foreground">
            {artifact.description}
          </div>
        ) : null}
        <div className="flex items-center gap-1.5 ps-8 text-label text-muted-foreground">
          {bot ? (
            <>
              <BotAvatar
                avatarSet={bot.avatarSet}
                color={bot.color}
                identity={bot.id}
                size={14}
                status={bot.status}
              />
              <span className="me-1 max-w-[140px] truncate">{bot.name}</span>
            </>
          ) : null}
          <span>{formatRelativeTime(artifact.createdAt)}</span>
        </div>
      </Link>
      <IconTooltip label={t`Delete ${artifact.name}`}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t`Delete ${artifact.name}`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onRequestDelete(artifact);
          }}
          className="absolute inset-y-0 end-2 my-auto text-muted-foreground opacity-0 hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 group-focus-within:opacity-100"
        >
          <Trash2 strokeWidth={1.9} />
        </Button>
      </IconTooltip>
    </div>
  );
}
