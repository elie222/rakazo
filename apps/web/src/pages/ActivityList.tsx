import { i18n } from "@lingui/core";
import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { RunActivityRow, RunStatus } from "@rakazo/contracts";
import { isAgedStuckWork } from "@rakazo/core";
import { Button, Input, Label, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import type { KeyboardEvent } from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ActivityListFilters } from "../lib/activity-list-filters";
import {
  activityFiltersActive,
  clearActivityFilterField,
  emptyActivityFilters,
  filterActivityRuns,
} from "../lib/activity-list-filters";
import { rpc } from "../lib/rpc";

export function statusTone(status: RunActivityRow["status"], updatedAt?: string): string {
  if (status === "failed") return "text-destructive";
  if (status === "cancelled") return "text-muted-foreground";
  if (status === "completed") return "text-success";
  if (status === "waiting_input" || status === "waiting_takeover") return "text-warning";
  if (updatedAt && isAgedStuckWork(status, updatedAt)) return "text-warning";
  return "text-foreground";
}

type ActivityListProps = {
  onOpenRun: (run: RunActivityRow) => void;
};

export function ActivityList({ onOpenRun }: ActivityListProps) {
  const { t } = useLingui();
  const searchId = useId();
  const statusId = useId();
  const fromId = useId();
  const toId = useId();
  const [activeRuns, setActiveRuns] = useState<RunActivityRow[]>([]);
  const [recentRuns, setRecentRuns] = useState<RunActivityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<ActivityListFilters>(() => emptyActivityFilters());

  const reloadRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let generation = 0;

    const load = () => {
      const requestId = ++generation;
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
      void (async () => {
        try {
          const [active, recent] = await Promise.all([
            rpc.runs.list({ filter: "active" }),
            rpc.runs.list({ filter: "recent" }),
          ]);
          if (cancelled || requestId !== generation) return;
          setActiveRuns(active.runs);
          setRecentRuns(recent.runs);
          setError(null);
        } catch (err) {
          if (cancelled || requestId !== generation) return;
          setError(err instanceof Error ? err.message : t`Could not load activity`);
        } finally {
          if (!cancelled && requestId === generation) {
            setLoading(false);
            timer = window.setTimeout(load, 15_000);
          }
        }
      })();
    };

    reloadRef.current = () => {
      setLoading(true);
      setError(null);
      load();
    };
    load();
    return () => {
      cancelled = true;
      reloadRef.current = null;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [t]);

  const filteredActive = useMemo(
    () => filterActivityRuns(activeRuns, filters),
    [activeRuns, filters],
  );
  const filteredRecent = useMemo(
    () => filterActivityRuns(recentRuns, filters),
    [recentRuns, filters],
  );

  const filtersOn = activityFiltersActive(filters);
  const hasAnyRuns = activeRuns.length > 0 || recentRuns.length > 0;
  const hasVisibleRuns = filteredActive.length > 0 || filteredRecent.length > 0;

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      setFilters((prev) => clearActivityFilterField(prev, "query"));
    }
  }

  if (loading && !hasAnyRuns && !filtersOn) {
    return (
      <div className="px-2.5 py-2 text-[13px] text-muted-foreground/80" role="status">
        <Trans>Loading activity…</Trans>
      </div>
    );
  }

  if (!hasAnyRuns && !filtersOn) {
    if (!error) return null;
    return (
      <div className="px-2.5 py-2" role="alert">
        <p className="text-[13px] text-destructive">{error}</p>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="mt-2 rounded-full"
          onClick={() => reloadRef.current?.()}
        >
          <Trans>Try again</Trans>
        </Button>
      </div>
    );
  }

  return (
    <div className="mb-2 border-b border-border pb-2" data-testid="activity-list">
      <ActivityFilters
        searchId={searchId}
        statusId={statusId}
        fromId={fromId}
        toId={toId}
        filters={filters}
        onChange={setFilters}
        onSearchKeyDown={handleSearchKeyDown}
      />

      {error ? (
        <div className="px-2.5 pb-2" role="alert">
          <p className="text-[12.5px] text-destructive">{error}</p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="mt-2 rounded-full"
            onClick={() => reloadRef.current?.()}
          >
            <Trans>Try again</Trans>
          </Button>
        </div>
      ) : null}

      {loading && !hasAnyRuns ? (
        <p className="px-2.5 py-2 text-[13px] text-muted-foreground/80" role="status">
          <Trans>Loading activity…</Trans>
        </p>
      ) : !error && filtersOn && hasAnyRuns && !hasVisibleRuns ? (
        <p className="px-2.5 py-2 text-[13px] text-muted-foreground/80" role="status">
          <Trans>No runs match these filters.</Trans>
        </p>
      ) : null}

      {filteredActive.length > 0 ? (
        <section aria-labelledby="activity-now-heading">
          <div
            id="activity-now-heading"
            className="px-2.5 pb-1 pt-1 text-[12.5px] font-medium text-muted-foreground/80"
          >
            <Trans>Now</Trans>
          </div>
          {filteredActive.map((run) => (
            <ActivityRow key={run.runId} run={run} onOpen={() => onOpenRun(run)} />
          ))}
        </section>
      ) : null}
      {filteredRecent.length > 0 ? (
        <section
          className={filteredActive.length > 0 ? "mt-2" : undefined}
          aria-labelledby="activity-recent-heading"
        >
          <div
            id="activity-recent-heading"
            className="px-2.5 pb-1 pt-1 text-[12.5px] font-medium text-muted-foreground/80"
          >
            <Trans>Recent</Trans>
          </div>
          {filteredRecent.map((run) => (
            <ActivityRow key={run.runId} run={run} onOpen={() => onOpenRun(run)} />
          ))}
        </section>
      ) : null}
    </div>
  );
}

const STATUS_FILTERS: RunStatus[] = [
  "running",
  "queued",
  "leased",
  "waiting_input",
  "waiting_takeover",
  "completed",
  "failed",
  "cancelled",
];

function ActivityFilters({
  searchId,
  statusId,
  fromId,
  toId,
  filters,
  onChange,
  onSearchKeyDown,
}: {
  searchId: string;
  statusId: string;
  fromId: string;
  toId: string;
  filters: ActivityListFilters;
  onChange: (next: ActivityListFilters) => void;
  onSearchKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
}) {
  const { t } = useLingui();
  const filtersOn = activityFiltersActive(filters);
  const statusLabelText = filters.status === "all" ? null : statusLabel(filters.status);

  return (
    <div className="mb-2 flex flex-col gap-2 px-2.5 pt-1">
      <div>
        <Label htmlFor={searchId} className="sr-only">
          <Trans>Search activity</Trans>
        </Label>
        <Input
          id={searchId}
          data-testid="activity-search"
          value={filters.query}
          onChange={(event) => onChange({ ...filters, query: event.target.value })}
          onKeyDown={onSearchKeyDown}
          placeholder={t`Search runs`}
          autoComplete="off"
          className="rounded-xl bg-card text-[13px] dark:bg-input"
        />
      </div>
      <div>
        <Label htmlFor={statusId} className="text-[12.5px] text-muted-foreground/80">
          <Trans>Status</Trans>
        </Label>
        <NativeSelect
          id={statusId}
          data-testid="activity-status-filter"
          value={filters.status}
          onChange={(event) =>
            onChange({
              ...filters,
              status: event.target.value as ActivityListFilters["status"],
            })
          }
          className="mt-1 w-full"
        >
          <NativeSelectOption value="all">{t`All statuses`}</NativeSelectOption>
          {STATUS_FILTERS.map((status) => (
            <NativeSelectOption key={status} value={status}>
              {statusLabel(status)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      <div>
        <Label htmlFor={fromId} className="text-[12.5px] text-muted-foreground/80">
          <Trans>From</Trans>
        </Label>
        <Input
          id={fromId}
          data-testid="activity-date-from"
          type="date"
          value={filters.dateRange.from}
          onChange={(event) =>
            onChange({
              ...filters,
              dateRange: { ...filters.dateRange, from: event.target.value },
            })
          }
          className="mt-1 rounded-xl bg-card text-[13px] dark:bg-input"
        />
      </div>
      <div>
        <Label htmlFor={toId} className="text-[12.5px] text-muted-foreground/80">
          <Trans>To</Trans>
        </Label>
        <Input
          id={toId}
          data-testid="activity-date-to"
          type="date"
          value={filters.dateRange.to}
          onChange={(event) =>
            onChange({
              ...filters,
              dateRange: { ...filters.dateRange, to: event.target.value },
            })
          }
          className="mt-1 rounded-xl bg-card text-[13px] dark:bg-input"
        />
      </div>
      {filtersOn ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {filters.query.trim() ? (
            <FilterChip
              label={t`Search: ${filters.query.trim()}`}
              onClear={() => onChange(clearActivityFilterField(filters, "query"))}
            />
          ) : null}
          {statusLabelText ? (
            <FilterChip
              label={statusLabelText}
              onClear={() => onChange(clearActivityFilterField(filters, "status"))}
            />
          ) : null}
          {filters.dateRange.from ? (
            <FilterChip
              label={t`From ${filters.dateRange.from}`}
              onClear={() => onChange(clearActivityFilterField(filters, "from"))}
            />
          ) : null}
          {filters.dateRange.to ? (
            <FilterChip
              label={t`To ${filters.dateRange.to}`}
              onClear={() => onChange(clearActivityFilterField(filters, "to"))}
            />
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 rounded-full px-2 text-[12px]"
            data-testid="activity-reset-filters"
            onClick={() => onChange(emptyActivityFilters())}
          >
            <Trans>Reset all</Trans>
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  const { t } = useLingui();
  return (
    <button
      type="button"
      className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11.5px] text-foreground hover:bg-accent"
      onClick={onClear}
      aria-label={t`Clear filter ${label}`}
    >
      <span className="truncate">{label}</span>
      <span aria-hidden>×</span>
    </button>
  );
}

function ActivityRow({ run, onOpen }: { run: RunActivityRow; onOpen: () => void }) {
  const { t } = useLingui();
  const title = run.groupName ? `${run.botName} · ${run.groupName}` : run.botName;
  const label = statusLabel(run.status);
  const activityLabel = t`${title}, ${label}`;
  const tone = statusTone(run.status, run.updatedAt);
  return (
    <button
      type="button"
      aria-label={activityLabel}
      onClick={onOpen}
      className="flex w-full gap-3 rounded-xl px-2.5 py-[9px] text-left hover:bg-accent"
    >
      <span
        className={`mt-1.5 size-2 shrink-0 rounded-full bg-current ${tone}`}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-medium text-foreground">{title}</span>
          <span className="shrink-0 text-xs text-muted-foreground/80">
            {formatRelativeTime(run.updatedAt)}
          </span>
        </div>
        <div className="mt-0.5 flex items-baseline gap-2">
          {run.promptSnippet ? (
            <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
              {run.promptSnippet}
            </span>
          ) : null}
          <span className={`ms-auto shrink-0 text-xs ${tone}`}>{label}</span>
        </div>
      </div>
    </button>
  );
}

function formatRelativeTime(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (seconds < 45) return t`just now`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t`${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t`${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return t`${days}d ago`;
  return date.toLocaleDateString(i18n.locale || "en", { month: "short", day: "numeric" });
}

export function statusLabel(status: RunActivityRow["status"]): string {
  switch (status) {
    case "queued":
      return t`Queued`;
    case "leased":
      return t`Starting`;
    case "running":
      return t`Running`;
    case "waiting_input":
      return t`Needs input`;
    case "waiting_takeover":
      return t`Needs takeover`;
    case "completed":
      return t`Done`;
    case "failed":
      return t`Failed`;
    case "cancelled":
      return t`Cancelled`;
    default:
      return status;
  }
}
