import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { Artifact, ArtifactVersion, Bot } from "@rakazo/contracts";
import { isAttachmentImageMimeType } from "@rakazo/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  BotAvatar,
  Button,
  NativeSelect,
  NativeSelectOption,
  parseBotAvatar,
  resolvePersonaColorDef,
} from "@rakazo/ui-web";
import {
  Download,
  Filter,
  LayoutGrid,
  List,
  Lock,
  Maximize2,
  Minimize2,
  Search,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { AppRail } from "../components/AppRail";
import { PdfViewer } from "../components/PdfViewer";
import { SandboxedHtmlViewer } from "../components/SandboxedHtmlViewer";
import { decodeArtifactBase64, downloadArtifactBytes } from "../lib/artifact-open";
import { takeInitialBootstrap } from "../lib/bootstrap";
import { formatRelativeTime } from "../lib/relative-time";
import { rpc } from "../lib/rpc";
import { useObjectUrl } from "../lib/use-object-url";

type ViewMode = "grid" | "list";
type DateFilter = "all" | "today" | "week" | "month";
const VIEW_MODE_STORAGE_KEY = "rakazo:artifacts-view-mode";
const LIST_PAGE_SIZE = 60;

type ArtifactSummary = Artifact & { versionCount: number };

function readViewMode(): ViewMode {
  try {
    return window.localStorage.getItem(VIEW_MODE_STORAGE_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

function writeViewMode(mode: ViewMode): void {
  try {
    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
  } catch {
    // Preference only; ignore storage failures.
  }
}

function matchesCalendarDateFilter(iso: string, filter: DateFilter, now: Date): boolean {
  if (filter === "all") return true;
  const date = new Date(iso);
  if (filter === "today") return date.toDateString() === now.toDateString();
  if (filter === "week") {
    const startOfWeek = new Date(now);
    startOfWeek.setHours(0, 0, 0, 0);
    startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
    return date >= startOfWeek;
  }
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
}

export function ArtifactsPage() {
  const { artifactId } = useParams<{ artifactId?: string }>();
  const navigate = useNavigate();
  const { t } = useLingui();
  const [bots, setBots] = useState<Bot[]>([]);
  const [items, setItems] = useState<ArtifactSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  const listingGenerationRef = useRef(0);
  const [activeBotId, setActiveBotId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>(readViewMode);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [dateFilter, setDateFilter] = useState<DateFilter>("all");
  const [maximized, setMaximized] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ArtifactSummary | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    void takeInitialBootstrap().then((bootstrap) => setBots(bootstrap.bots));
  }, []);

  useEffect(() => {
    let cancelled = false;
    listingGenerationRef.current += 1;
    loadingMoreRef.current = false;
    setLoadingMore(false);
    setItems(null);
    setLoadError(null);
    setNextCursor(null);
    void rpc.artifacts
      .listSpace({ botId: activeBotId ?? undefined, limit: LIST_PAGE_SIZE })
      .then((page) => {
        if (cancelled) return;
        setItems(page.items);
        setNextCursor(page.nextCursor);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : t`Could not load artifacts.`);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeBotId, t]);

  async function loadMore() {
    if (!nextCursor || loadingMoreRef.current) return;
    const generation = listingGenerationRef.current;
    const listingChanged = () => generation !== listingGenerationRef.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const page = await rpc.artifacts.listSpace({
        botId: activeBotId ?? undefined,
        cursor: nextCursor,
        limit: LIST_PAGE_SIZE,
      });
      if (listingChanged()) return;
      setItems((current) => (current ?? []).concat(page.items));
      setNextCursor(page.nextCursor);
    } catch {
      // Keep the current page so Load more can be retried.
    } finally {
      if (!listingChanged()) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }

  useEffect(() => {
    setMaximized(false);
  }, [artifactId]);

  const botsById = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);

  const filteredItems = useMemo(() => {
    if (!items) return null;
    const now = new Date();
    const query = searchQuery.trim().toLowerCase();
    return items.filter((item) => {
      if (!matchesCalendarDateFilter(item.createdAt, dateFilter, now)) return false;
      if (!query) return true;
      return (
        item.name.toLowerCase().includes(query) ||
        (item.description?.toLowerCase().includes(query) ?? false)
      );
    });
  }, [items, searchQuery, dateFilter]);

  const clientFilterActive = searchQuery.trim().length > 0 || dateFilter !== "all";
  const autoFetchedCursorRef = useRef<string | null>(null);

  useEffect(() => {
    autoFetchedCursorRef.current = null;
  }, [searchQuery, dateFilter, activeBotId]);

  // Search and date filters only see loaded pages, so keep paging until something matches.
  useEffect(() => {
    if (!clientFilterActive || !nextCursor || loadingMore || items === null) return;
    if (filteredItems && filteredItems.length > 0) return;
    if (autoFetchedCursorRef.current === nextCursor) return;
    autoFetchedCursorRef.current = nextCursor;
    void loadMore();
  }, [clientFilterActive, nextCursor, loadingMore, items, filteredItems]);

  function setMode(mode: ViewMode) {
    setViewMode(mode);
    writeViewMode(mode);
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await rpc.artifacts.remove({ artifactId: pendingDelete.id });
      setItems((current) => current?.filter((item) => item.id !== pendingDelete.id) ?? current);
      if (artifactId === pendingDelete.id) navigate("/app/artifacts");
      setPendingDelete(null);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : t`Could not delete this artifact.`);
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <div className="flex h-full min-w-0 bg-background text-foreground/90">
      <AppRail active="artifacts" />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="border-b border-border px-6 py-4">
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-xl font-semibold">
              <Trans>Artifacts</Trans>
            </h1>
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-pressed={filtersOpen}
                onClick={() => setFiltersOpen((open) => !open)}
                className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[13px] font-medium transition-colors ${
                  filtersOpen
                    ? "border-transparent bg-primary text-primary-foreground"
                    : "border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                }`}
              >
                <Filter size={14} strokeWidth={1.9} />
                <Trans>Filters</Trans>
              </button>
              {!artifactId ? (
                <div className="flex items-center gap-1 rounded-lg border border-border p-0.5">
                  <ViewModeButton
                    active={viewMode === "grid"}
                    label={t`Card view`}
                    onClick={() => setMode("grid")}
                  >
                    <LayoutGrid size={15} strokeWidth={1.9} />
                  </ViewModeButton>
                  <ViewModeButton
                    active={viewMode === "list"}
                    label={t`List view`}
                    onClick={() => setMode("list")}
                  >
                    <List size={15} strokeWidth={1.9} />
                  </ViewModeButton>
                </div>
              ) : null}
            </div>
          </div>

          {filtersOpen ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <div className="relative w-full max-w-[260px]">
                <Search
                  size={14}
                  strokeWidth={1.9}
                  className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                />
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder={t`Search artifacts…`}
                  className="w-full rounded-lg border border-border bg-background py-1.5 ps-8 pe-3 text-[13px] outline-none focus:border-ring"
                />
              </div>
              <NativeSelect
                aria-label={t`Filter by date`}
                className="w-auto text-[13px]"
                value={dateFilter}
                onChange={(event) => setDateFilter(event.target.value as DateFilter)}
              >
                <NativeSelectOption value="all">{t`All time`}</NativeSelectOption>
                <NativeSelectOption value="today">{t`Today`}</NativeSelectOption>
                <NativeSelectOption value="week">{t`This week`}</NativeSelectOption>
                <NativeSelectOption value="month">{t`This month`}</NativeSelectOption>
              </NativeSelect>
              <FilterChip active={activeBotId === null} onClick={() => setActiveBotId(null)}>
                <Trans>All bots</Trans>
              </FilterChip>
              {bots.map((bot) => (
                <BotFilterChip
                  key={bot.id}
                  bot={bot}
                  active={activeBotId === bot.id}
                  onClick={() => setActiveBotId(bot.id)}
                />
              ))}
            </div>
          ) : null}
        </header>

        <div className="flex min-h-0 flex-1 overflow-hidden">
          {artifactId ? (
            <>
              {!maximized ? (
                <IndexPane
                  items={filteredItems}
                  loadError={loadError}
                  botsById={botsById}
                  selectedId={artifactId}
                  onRequestDelete={setPendingDelete}
                  nextCursor={nextCursor}
                  loadingMore={loadingMore}
                  onLoadMore={() => void loadMore()}
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
              onRequestDelete={setPendingDelete}
              nextCursor={nextCursor}
              loadingMore={loadingMore}
              onLoadMore={() => void loadMore()}
            />
          )}
        </div>
      </div>

      {pendingDelete ? (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open && !deleteBusy) setPendingDelete(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                <Trans>Delete "{pendingDelete.name}"?</Trans>
              </AlertDialogTitle>
              <AlertDialogDescription>
                {pendingDelete.versionCount > 1 ? (
                  <Trans>
                    This deletes all {pendingDelete.versionCount} versions of this artifact. This
                    can't be undone.
                  </Trans>
                ) : (
                  <Trans>This can't be undone.</Trans>
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {deleteError ? <p className="text-[13.5px] text-destructive">{deleteError}</p> : null}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleteBusy}>
                <Trans>Cancel</Trans>
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={deleteBusy}
                onClick={() => void confirmDelete()}
              >
                {deleteBusy ? <Trans>Deleting…</Trans> : <Trans>Delete</Trans>}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </div>
  );
}

function BrowsingPane({
  items,
  loadError,
  viewMode,
  botsById,
  onRequestDelete,
  nextCursor,
  loadingMore,
  onLoadMore,
}: {
  items: ArtifactSummary[] | null;
  loadError: string | null;
  viewMode: ViewMode;
  botsById: Map<string, Bot>;
  onRequestDelete: (artifact: ArtifactSummary) => void;
  nextCursor: string | null;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  if (items === null) {
    return (
      <div className="grid flex-1 place-items-center text-sm text-muted-foreground/80">
        {loadError ?? <Trans>Loading…</Trans>}
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <EmptyArtifacts
        className="grid flex-1 place-items-center text-sm text-muted-foreground/80"
        nextCursor={nextCursor}
        loadingMore={loadingMore}
        onLoadMore={onLoadMore}
      />
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
      {viewMode === "grid" ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
          {items.map((item) => (
            <ArtifactCard
              key={item.id}
              artifact={item}
              bot={item.botId ? botsById.get(item.botId) : undefined}
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
      <Button variant="outline" size="sm" disabled={loading} onClick={onClick}>
        {loading ? <Trans>Loading…</Trans> : <Trans>Load more</Trans>}
      </Button>
    </div>
  );
}

function EmptyArtifacts({
  className,
  nextCursor,
  loadingMore,
  onLoadMore,
}: {
  className: string;
  nextCursor: string | null;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  if (!nextCursor) {
    return (
      <div className={className}>
        <Trans>No artifacts found.</Trans>
      </div>
    );
  }
  return (
    <div className={className}>
      <div className="flex flex-col items-center gap-3">
        <span>
          {loadingMore ? (
            <Trans>Loading…</Trans>
          ) : (
            <Trans>No matching artifacts on this page.</Trans>
          )}
        </span>
        <LoadMoreButton loading={loadingMore} onClick={onLoadMore} />
      </div>
    </div>
  );
}

function IndexPane({
  items,
  loadError,
  botsById,
  selectedId,
  onRequestDelete,
  nextCursor,
  loadingMore,
  onLoadMore,
}: {
  items: ArtifactSummary[] | null;
  loadError: string | null;
  botsById: Map<string, Bot>;
  selectedId: string;
  onRequestDelete: (artifact: ArtifactSummary) => void;
  nextCursor: string | null;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  return (
    <aside className="flex w-[320px] shrink-0 flex-col overflow-y-auto border-e border-border">
      {items === null ? (
        <div className="grid flex-1 place-items-center p-6 text-center text-sm text-muted-foreground/80">
          {loadError ?? <Trans>Loading…</Trans>}
        </div>
      ) : items.length === 0 ? (
        <EmptyArtifacts
          className="grid flex-1 place-items-center p-6 text-center text-sm text-muted-foreground/80"
          nextCursor={nextCursor}
          loadingMore={loadingMore}
          onLoadMore={onLoadMore}
        />
      ) : (
        <div className="flex flex-col divide-y divide-border">
          {items.map((item) => (
            <ArtifactRow
              key={item.id}
              artifact={item}
              bot={item.botId ? botsById.get(item.botId) : undefined}
              active={item.id === selectedId}
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

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-3 py-1.5 text-[13px] font-medium transition-colors ${
        active
          ? "bg-primary text-primary-foreground"
          : "border border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function useBotColorHex(bot: Bot): string {
  return useMemo(() => {
    const parsed = parseBotAvatar(bot.color, bot.id);
    const effectiveId = bot.id || parsed.color || "agent";
    return resolvePersonaColorDef(effectiveId, parsed.color).hex;
  }, [bot.color, bot.id]);
}

function BotFilterChip({
  bot,
  active,
  onClick,
}: {
  bot: Bot;
  active: boolean;
  onClick: () => void;
}) {
  const hex = useBotColorHex(bot);
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ backgroundColor: active ? `${hex}26` : undefined, borderColor: `${hex}66` }}
      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[13px] font-medium transition-colors ${
        active
          ? "text-foreground"
          : "text-muted-foreground hover:bg-accent/40 hover:text-accent-foreground"
      }`}
    >
      <BotAvatar color={bot.color} identity={bot.id} size={16} status={bot.status} />
      <span className="max-w-[120px] truncate">{bot.name}</span>
    </button>
  );
}

function ViewModeButton({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onClick}
      className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
        active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function ArtifactCard({
  artifact,
  bot,
  onRequestDelete,
}: {
  artifact: ArtifactSummary;
  bot: Bot | undefined;
  onRequestDelete: (artifact: ArtifactSummary) => void;
}) {
  const { t } = useLingui();
  return (
    <div className="group relative">
      <Link
        to={`/app/artifacts/${artifact.id}`}
        className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-4 text-foreground hover:bg-accent/40"
      >
        <div className="flex items-start justify-between">
          <span className="grid h-9 w-9 place-items-center rounded-[10px] bg-accent text-accent-foreground">
            <ArtifactMimeIcon mimeType={artifact.mimeType} />
          </span>
          <div className="flex items-center gap-1.5">
            {artifact.versionCount > 1 ? (
              <span className="rounded-md bg-muted px-2 py-1 text-[11px] font-semibold text-muted-foreground">
                {`v${artifact.version}`}
              </span>
            ) : null}
            <span className="rounded-md bg-muted px-2 py-1 text-[11px] font-semibold text-muted-foreground">
              {mimeLabel(artifact.mimeType)}
            </span>
          </div>
        </div>
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold">{artifact.name}</div>
          {artifact.description ? (
            <div className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-muted-foreground">
              {artifact.description}
            </div>
          ) : null}
        </div>
        <div className="mt-auto flex items-center gap-2 text-[12px] text-muted-foreground">
          {bot ? (
            <>
              <BotAvatar color={bot.color} identity={bot.id} size={20} status={bot.status} />
              <span className="min-w-0 flex-1 truncate">{bot.name}</span>
            </>
          ) : (
            <span className="flex-1" />
          )}
          <span className="shrink-0">{formatRelativeTime(artifact.createdAt)}</span>
        </div>
      </Link>
      <button
        type="button"
        aria-label={t`Delete ${artifact.name}`}
        title={t`Delete ${artifact.name}`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onRequestDelete(artifact);
        }}
        className="absolute bottom-3 end-3 grid h-7 w-7 place-items-center rounded-lg bg-card text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 group-focus-within:opacity-100"
      >
        <Trash2 size={14} strokeWidth={1.9} />
      </button>
    </div>
  );
}

function ArtifactRow({
  artifact,
  bot,
  active,
  onRequestDelete,
}: {
  artifact: ArtifactSummary;
  bot: Bot | undefined;
  active?: boolean;
  onRequestDelete: (artifact: ArtifactSummary) => void;
}) {
  const { t } = useLingui();
  return (
    <div className={`group relative ${active ? "bg-accent/60" : "hover:bg-accent/40"}`}>
      <Link to={`/app/artifacts/${artifact.id}`} className="flex flex-col gap-1 px-4 py-3 pe-10">
        <div className="flex items-center gap-2">
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-[7px] bg-accent text-accent-foreground">
            <ArtifactMimeIcon mimeType={artifact.mimeType} small />
          </span>
          <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{artifact.name}</span>
          {artifact.versionCount > 1 ? (
            <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10.5px] font-semibold text-muted-foreground">
              {`v${artifact.version}`}
            </span>
          ) : null}
        </div>
        {artifact.description ? (
          <div className="ps-8 text-[12.5px] leading-snug text-muted-foreground">
            {artifact.description}
          </div>
        ) : null}
        <div className="flex items-center gap-1.5 ps-8 text-[11.5px] text-muted-foreground">
          {bot ? (
            <>
              <BotAvatar color={bot.color} identity={bot.id} size={14} status={bot.status} />
              <span className="max-w-[140px] truncate">{bot.name}</span>
              <span aria-hidden="true">·</span>
            </>
          ) : null}
          <span>{formatRelativeTime(artifact.createdAt)}</span>
        </div>
      </Link>
      <button
        type="button"
        aria-label={t`Delete ${artifact.name}`}
        title={t`Delete ${artifact.name}`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onRequestDelete(artifact);
        }}
        className="absolute end-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-lg text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 group-focus-within:opacity-100"
      >
        <Trash2 size={14} strokeWidth={1.9} />
      </button>
    </div>
  );
}

function ArtifactMimeIcon({ mimeType, small }: { mimeType: string; small?: boolean }) {
  const size = small ? 12 : 16;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {mimeType === "text/html" ? (
        <>
          <polyline points="8 6 2 12 8 18" />
          <polyline points="16 6 22 12 16 18" />
        </>
      ) : (
        <>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </>
      )}
    </svg>
  );
}

function mimeLabel(mimeType: string): string {
  if (mimeType === "text/html") return "HTML";
  if (mimeType === "text/markdown") return "MD";
  if (mimeType === "application/pdf") return "PDF";
  const slash = mimeType.indexOf("/");
  return (slash === -1 ? mimeType : mimeType.slice(slash + 1)).toUpperCase().slice(0, 6);
}

function PreviewPane({
  artifactId,
  maximized,
  onToggleMaximize,
}: {
  artifactId: string;
  maximized: boolean;
  onToggleMaximize: () => void;
}) {
  const { t } = useLingui();
  const [versions, setVersions] = useState<ArtifactVersion[] | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; artifact: Artifact; bytes: Uint8Array }
    | { status: "error"; message: string }
  >({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setVersions(null);
    setSelectedVersionId(null);
    void rpc.artifacts
      .listVersions({ familyId: artifactId })
      .then((list) => {
        if (cancelled) return;
        setVersions(list);
        setSelectedVersionId(list[0]?.id ?? artifactId);
      })
      .catch(() => {
        if (!cancelled) setSelectedVersionId(artifactId);
      });
    return () => {
      cancelled = true;
    };
  }, [artifactId]);

  useEffect(() => {
    if (!selectedVersionId) return;
    let cancelled = false;
    setState({ status: "loading" });
    void rpc.artifacts
      .getById({ artifactId: selectedVersionId })
      .then((artifact) => {
        if (!cancelled) {
          setState({
            status: "ready",
            artifact,
            bytes: decodeArtifactBase64(artifact.contentBase64),
          });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            message: error instanceof Error ? error.message : t`Could not load this artifact.`,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedVersionId, t]);

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-border px-6 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[16px] font-semibold">
            {state.status === "ready" ? state.artifact.name : t`Loading…`}
          </h2>
          {state.status === "ready" && state.artifact.description ? (
            <p className="truncate text-[12.5px] text-muted-foreground">
              {state.artifact.description}
            </p>
          ) : null}
        </div>
        {versions && versions.length > 1 && selectedVersionId ? (
          <NativeSelect
            aria-label={t`Version`}
            className="w-auto shrink-0 text-[13px]"
            value={selectedVersionId}
            onChange={(event) => setSelectedVersionId(event.target.value)}
          >
            {versions.map((entry) => (
              <NativeSelectOption key={entry.id} value={entry.id}>
                {`v${entry.version} · ${formatRelativeTime(entry.createdAt)}`}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        ) : null}
        {state.status === "ready" ? (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                downloadArtifactBytes(state.artifact.name, state.artifact.mimeType, state.bytes)
              }
            >
              <Download className="me-1.5" size={15} strokeWidth={1.9} />
              <Trans>Download</Trans>
            </Button>
            <button
              type="button"
              aria-label={maximized ? t`Show list` : t`Maximize`}
              title={maximized ? t`Show list` : t`Maximize`}
              onClick={onToggleMaximize}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-border text-muted-foreground hover:bg-accent"
            >
              {maximized ? (
                <Minimize2 size={15} strokeWidth={1.9} />
              ) : (
                <Maximize2 size={15} strokeWidth={1.9} />
              )}
            </button>
          </>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 p-5">
        {state.status === "loading" ? (
          <div className="grid h-full place-items-center text-sm text-muted-foreground/80">
            <Trans>Loading…</Trans>
          </div>
        ) : state.status === "error" ? (
          <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-destructive">
            {state.message}
          </div>
        ) : (
          <div className="relative h-full overflow-hidden rounded-2xl border border-border">
            <ArtifactPreview artifact={state.artifact} bytes={state.bytes} />
            {state.artifact.mimeType === "text/html" ? (
              <div className="absolute bottom-3 end-3 flex items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1.5 text-[11px] text-white">
                <Lock size={12} strokeWidth={2} />
                <span>
                  <Trans>Isolated preview — no access to your account</Trans>
                </span>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function ArtifactPreview({ artifact, bytes }: { artifact: Artifact; bytes: Uint8Array }) {
  if (artifact.mimeType === "text/html") {
    const html = new TextDecoder("utf-8").decode(bytes);
    return <SandboxedHtmlViewer html={html} title={artifact.name} />;
  }
  if (artifact.mimeType === "text/markdown") {
    const text = new TextDecoder("utf-8").decode(bytes);
    return (
      <div className="h-full overflow-y-auto bg-background">
        <article className="mx-auto w-full max-w-[760px] px-8 py-10 text-[16px] leading-7 text-foreground">
          <ChatMarkdown>{text}</ChatMarkdown>
        </article>
      </div>
    );
  }
  if (artifact.mimeType === "application/pdf") {
    return <PdfViewer bytes={bytes} title={artifact.name} />;
  }
  if (isAttachmentImageMimeType(artifact.mimeType)) {
    return <ImagePreview bytes={bytes} mimeType={artifact.mimeType} name={artifact.name} />;
  }
  return (
    <div className="grid h-full place-items-center px-6 text-center text-sm text-muted-foreground/80">
      <Trans>Preview isn't available for this file type — download it to view it.</Trans>
    </div>
  );
}

function ImagePreview({
  bytes,
  mimeType,
  name,
}: {
  bytes: Uint8Array;
  mimeType: string;
  name: string;
}) {
  const url = useObjectUrl(bytes, mimeType);
  if (!url) return null;
  return (
    <div className="grid h-full place-items-center overflow-auto bg-muted/40 p-4">
      <img src={url} alt={name} className="max-h-full max-w-full rounded-lg shadow-sm" />
    </div>
  );
}
