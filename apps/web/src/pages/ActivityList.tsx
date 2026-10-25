import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { RunActivityRow, RunStatus } from "@rakazo/contracts";
import { isAgedStuckWork, isRetryableError } from "@rakazo/core";
import {
  Button,
  Collapsible,
  CollapsibleContent,
  Input,
  Label,
  NativeSelect,
  NativeSelectOption,
  Spinner,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useId, useMemo, useState } from "react";
import type { ActivityListFilters } from "../lib/activity-list-filters";
import {
  activityFiltersActive,
  activityPreview,
  clearActivityFilterField,
  emptyActivityFilters,
  filterActivityRuns,
} from "../lib/activity-list-filters";
import { useSpaceQueries } from "../lib/query";
import { formatRelativeTime } from "../lib/relative-time";

export function statusTone(status: RunActivityRow["status"], updatedAt?: string): string {
  if (status === "failed") return "text-destructive";
  if (status === "cancelled") return "text-muted-foreground";
  if (status === "completed") return "text-success";
  if (status === "waiting_input" || status === "waiting_takeover") return "text-warning";
  if (updatedAt && isAgedStuckWork(status, updatedAt)) return "text-warning";
  return "text-foreground";
}

const NO_RUNS: RunActivityRow[] = [];

type ActivityListProps = {
  onOpenRun: (run: RunActivityRow) => void;
  filters: ActivityListFilters;
  onFiltersChange: (next: ActivityListFilters) => void;
  filtersExpanded: boolean;
  filtersId: string;
};

export function ActivityList({
  onOpenRun,
  filters,
  onFiltersChange,
  filtersExpanded,
  filtersId,
}: ActivityListProps) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  // Polls while open; a refused request (signed out, forbidden) stops polling.
  const poll = {
    refetchInterval: (query: { state: { error: unknown } }) =>
      query.state.error && !isRetryableError(query.state.error) ? false : 15_000,
  } as const;
  const active = useQuery(queries.runs.list.queryOptions({ input: { filter: "active" }, ...poll }));
  const recent = useQuery(queries.runs.list.queryOptions({ input: { filter: "recent" }, ...poll }));
  const activeRuns = active.data?.runs ?? NO_RUNS;
  const recentRuns = recent.data?.runs ?? NO_RUNS;
  // "Try again" shows its progress in place of the error it answers.
  const [retrying, setRetrying] = useState(false);
  const loading = active.isPending || recent.isPending || retrying;
  const failure = retrying ? null : (active.error ?? recent.error);
  const error = failure
    ? failure instanceof Error
      ? failure.message
      : t`Could not load activity`
    : null;
  const retry = () => {
    setRetrying(true);
    void Promise.all([active.refetch(), recent.refetch()]).finally(() => setRetrying(false));
  };

  const filteredActive = useMemo(
    () => filterActivityRuns(activeRuns, filters),
    [activeRuns, filters, t],
  );
  const filteredRecent = useMemo(
    () => filterActivityRuns(recentRuns, filters),
    [recentRuns, filters, t],
  );

  const filtersOn = activityFiltersActive(filters);
  const hasAnyRuns = activeRuns.length > 0 || recentRuns.length > 0;
  const hasVisibleRuns = filteredActive.length > 0 || filteredRecent.length > 0;

  return (
    <div
      className={
        hasAnyRuns || filtersOn || filtersExpanded ? "mb-2 border-b border-border pb-2" : undefined
      }
      data-testid="activity-list"
    >
      <ActivityFilters
        filters={filters}
        onChange={onFiltersChange}
        expanded={filtersExpanded}
        id={filtersId}
      />

      {error ? (
        <div className="px-2.5 pb-2" role="alert">
          <ActivityError error={error} onRetry={retry} compact />
        </div>
      ) : null}

      {loading && !hasAnyRuns ? (
        <p className="px-2.5 py-2 text-[13px] text-muted-foreground/80">
          <Spinner aria-label={t`Loading activity…`} />
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

function ActivityError({
  error,
  onRetry,
  compact = false,
}: {
  error: string;
  onRetry: () => void;
  compact?: boolean;
}) {
  return (
    <>
      <p className={`${compact ? "text-[12.5px]" : "text-[13px]"} text-destructive`}>{error}</p>
      <Button type="button" variant="secondary" size="sm" className="mt-2" onClick={onRetry}>
        <Trans>Try again</Trans>
      </Button>
    </>
  );
}

function ActivityFilters({
  filters,
  onChange,
  expanded,
  id,
}: {
  expanded: boolean;
  id: string;
  filters: ActivityListFilters;
  onChange: (next: ActivityListFilters) => void;
}) {
  const { t } = useLingui();
  const statusId = useId();
  const fromId = useId();
  const toId = useId();
  const filtersOn = activityFiltersActive(filters);
  const statusLabelText = filters.status === "all" ? null : statusLabel(filters.status);

  return (
    <div className="flex flex-col">
      <Collapsible open={expanded} className="contents">
        <CollapsibleContent id={id} keepMounted className="flex flex-col">
          <div className="space-y-2 pt-1 pb-2">
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
            <div className="grid grid-cols-2 gap-2">
              <div className="min-w-0">
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
              <div className="min-w-0">
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
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
      {filtersOn ? (
        <div className="mb-2 flex flex-wrap items-center gap-1.5 pt-1">
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
            className="h-7 px-2 text-[12px]"
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
  const title = run.groupName ? `${run.botName}, ${run.groupName}` : run.botName;
  const label = statusLabel(run.status);
  const activityLabel = t`${title}, ${label}`;
  const tone = statusTone(run.status, run.updatedAt);
  const preview = activityPreview(run);
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
          <span className="flex min-w-0 gap-2 text-sm font-medium">
            <span className="truncate text-foreground">{run.botName}</span>
            {run.groupName ? (
              <span className="truncate text-muted-foreground">{run.groupName}</span>
            ) : null}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground/80">
            {formatRelativeTime(run.updatedAt)}
          </span>
        </div>
        <div className="mt-0.5 flex items-baseline gap-2">
          {preview ? (
            <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
              {preview}
            </span>
          ) : null}
          <span className={`ms-auto shrink-0 text-xs ${tone}`}>{label}</span>
        </div>
      </div>
    </button>
  );
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
