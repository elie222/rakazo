import { Trans, useLingui } from "@lingui/react/macro";
import type { ModelCatalogEntry, UsageBreakdownBot, UsageDateRange } from "@rakazo/contracts";
import {
  OptionSelect,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SectionHeading,
  ToggleGroup,
  ToggleGroupItem,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@rakazo/ui-web";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@rakazo/ui-web/components/ui/table";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { RefObject } from "react";
import { useEffect, useState } from "react";
import { useSpaceQueries } from "../../lib/query/query";
import { usageModelKey, usageModelLabels } from "./usage-model-labels";

/** A round top above `max`, with four even steps (0, 5M, 10M, 15M, 20M). */
function tokenAxis(max: number): { top: number; ticks: number[] } {
  const steps = 4;
  if (max <= 0) return { top: steps, ticks: [steps, 3, 2, 1, 0] };
  const rough = max / steps;
  const exponent = Math.floor(Math.log10(rough));
  const base = 10 ** exponent;
  const fraction = rough / base;
  const step = (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * base;
  let top = step * steps;
  while (top < max) top += step;
  const ticks: number[] = [];
  for (let value = top; value >= 0; value -= step) ticks.push(value);
  return { top, ticks };
}

function formatUsageDate(iso: string, locale: string, monthly: boolean): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(
    locale,
    monthly
      ? { month: "short", year: "numeric", timeZone: "UTC" }
      : { month: "short", day: "numeric", timeZone: "UTC" },
  );
}

/** Fixed-width label: "Sep 01 – Nov 19". The day is always two digits so the button does not resize. */
function formatRangeBound(iso: string, locale: string, monthly: boolean): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(
    locale,
    monthly
      ? { month: "short", year: "numeric", timeZone: "UTC" }
      : { month: "short", day: "2-digit", timeZone: "UTC" },
  );
}

function localIso(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function shiftIso(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The smallest preset that still includes `start`, so a chosen interval can be loaded and then trimmed. */
function presetCovering(start: string, today = localIso(new Date())): UsageDateRange {
  if (start >= today) return "today";
  if (start >= shiftIso(today, -6)) return "7d";
  if (start >= shiftIso(today, -29)) return "30d";
  return "all";
}

function presetBounds(
  range: UsageDateRange,
  today = localIso(new Date()),
): { start: string; end: string } | null {
  if (range === "all") return null;
  const daysBack = range === "today" ? 0 : range === "7d" ? 6 : 29;
  return { start: shiftIso(today, -daysBack), end: today };
}

function monthCells(year: number, month: number): (string | null)[] {
  const first = new Date(Date.UTC(year, month, 1));
  const count = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const cells: (string | null)[] = Array.from({ length: first.getUTCDay() }, () => null);
  for (let day = 1; day <= count; day += 1) {
    cells.push(new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10));
  }
  return cells;
}

function axisLabelIndexes(count: number): number[] {
  if (count <= 8) return Array.from({ length: count }, (_, index) => index);
  const stride = count > 16 ? 3 : 2;
  const indexes: number[] = [];
  for (let index = 0; index < count; index += stride) indexes.push(index);
  return indexes;
}

function UsageShimmer({ className }: { className: string }) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden
      className={`animate-pulse bg-foreground/15 ${className}`}
    />
  );
}

function ChartShimmer() {
  const heights = [
    "h-[18%]",
    "h-[34%]",
    "h-[22%]",
    "h-[72%]",
    "h-[46%]",
    "h-[28%]",
    "h-[84%]",
    "h-[40%]",
  ];
  return (
    <div className="flex h-56 items-end gap-3" aria-hidden>
      {heights.map((height) => (
        <UsageShimmer key={height} className={`min-w-0 flex-1 rounded-t-[3px] ${height}`} />
      ))}
    </div>
  );
}

function formatAxisTokens(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    const text =
      millions >= 10 || Number.isInteger(millions) ? String(millions) : millions.toFixed(1);
    return `${text}M`;
  }
  if (value >= 1_000) {
    const thousands = value / 1_000;
    const text =
      thousands >= 10 || Number.isInteger(thousands)
        ? String(Math.round(thousands))
        : thousands.toFixed(1);
    return `${text}K`;
  }
  return String(value);
}

export function UsageSettingsPanel({ panelRef }: { panelRef?: RefObject<HTMLDivElement | null> }) {
  const { t, i18n } = useLingui();
  const queries = useSpaceQueries();
  const [range, setRange] = useState<UsageDateRange>("30d");
  const [applied, setApplied] = useState<{ start: string; end: string } | null>(null);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [draftStart, setDraftStart] = useState<string | null>(null);
  const [draftEnd, setDraftEnd] = useState<string | null>(null);
  const [visibleMonth, setVisibleMonth] = useState(() => {
    const now = new Date();
    return { year: now.getUTCFullYear(), month: now.getUTCMonth() };
  });
  const [selectedBot, setSelectedBot] = useState<UsageBreakdownBot | null>(null);
  const [selectedModel, setSelectedModel] = useState<{ key: string; label: string } | null>(null);
  const botId = selectedBot?.id ?? "all";
  const modelKey = selectedModel?.key ?? "all";

  const input = {
    range,
    ...(botId !== "all" ? { botId } : {}),
    ...(modelKey !== "all"
      ? (([provider, model]) => ({ provider, model }))(JSON.parse(modelKey) as [string, string])
      : {}),
  };

  const { data, isError, isPlaceholderData } = useQuery({
    ...queries.usage.breakdown.queryOptions({ input }),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  const catalogQuery = useQuery(queries.models.list.queryOptions());
  const catalog = catalogQuery.data ?? NO_CATALOG;
  const fallbackLabel =
    catalogQuery.data !== undefined
      ? t`Unlisted model`
      : catalogQuery.isError
        ? t`Model name unavailable`
        : t`Loading model name…`;

  const count = new Intl.NumberFormat(i18n.locale);
  const usd = new Intl.NumberFormat(i18n.locale, { style: "currency", currency: "USD" });
  const number = (value: number | null | undefined) => (value == null ? "—" : count.format(value));
  const cost = (value: number | null | undefined) =>
    value == null ? "—" : value > 0 && value < 0.01 ? `<${usd.format(0.01)}` : usd.format(value);

  const ranges: { id: UsageDateRange; label: string }[] = [
    { id: "today", label: t`1d` },
    { id: "7d", label: t`7d` },
    { id: "30d", label: t`30d` },
    { id: "all", label: t`All` },
  ];

  // The lists keep the previous result while the next one loads; the numbers never do, nor after a failed read.
  const loading = !isError && (isPlaceholderData || !data);
  const fresh = isPlaceholderData || isError ? undefined : data;
  const bots = data?.bots ?? (selectedBot ? [selectedBot] : []);
  const models = fresh?.models ?? [];
  const overTime = fresh?.overTime ?? [];
  const monthly = fresh?.overTimeUnit === "month";
  const totals = fresh?.totals;
  const modelLabels = usageModelLabels(data?.modelOptions ?? [], catalog, fallbackLabel);
  const modelOptions = data ? modelLabels.options : selectedModel ? [selectedModel] : [];

  // A new date range can drop the selected bot or model from the lists: go back to all.
  useEffect(() => {
    if (!data || isPlaceholderData) return;
    if (botId !== "all" && !data.bots.some((b) => b.id === botId)) setSelectedBot(null);
    if (modelKey !== "all" && !modelOptions.some((m) => m.key === modelKey)) setSelectedModel(null);
  }, [data, isPlaceholderData, botId, modelKey, modelOptions]);

  const chartPoints = applied
    ? overTime.filter((point) => point.date >= applied.start && point.date <= applied.end)
    : overTime;
  const coversAll =
    !applied || overTime.every((point) => point.date >= applied.start && point.date <= applied.end);
  const displayTotals =
    !applied || coversAll || !fresh
      ? totals
      : {
          runs: null,
          totalTokens: chartPoints.reduce((sum, point) => sum + (point.totalTokens ?? 0), 0),
          costUsd: chartPoints.reduce((sum, point) => sum + (point.costUsd ?? 0), 0),
        };
  const hasTokens = chartPoints.some((point) => (point.totalTokens ?? 0) > 0);
  const maxTokens = Math.max(0, ...chartPoints.map((point) => point.totalTokens ?? 0));
  const axis = tokenAxis(maxTokens);
  const bounds =
    applied ??
    (overTime.length > 0
      ? { start: overTime[0]?.date ?? "", end: overTime.at(-1)?.date ?? "" }
      : presetBounds(range));
  const rangeDates = bounds
    ? `${formatRangeBound(bounds.start, i18n.locale, monthly && !applied)} – ${formatRangeBound(bounds.end, i18n.locale, monthly && !applied)}`
    : t`All time`;
  const weekdays = Array.from({ length: 7 }, (_, index) =>
    new Date(Date.UTC(2024, 0, 7 + index)).toLocaleDateString(i18n.locale, {
      weekday: "narrow",
      timeZone: "UTC",
    }),
  );
  const monthTitle = new Date(
    Date.UTC(visibleMonth.year, visibleMonth.month, 1),
  ).toLocaleDateString(i18n.locale, { month: "long", year: "numeric", timeZone: "UTC" });

  function openCalendar(open: boolean) {
    setCalendarOpen(open);
    if (!open) return;
    const start = overTime[0]?.date ?? null;
    const end = overTime.at(-1)?.date ?? start;
    setDraftStart(start);
    setDraftEnd(end);
    const focus = end ?? start;
    if (focus) {
      const [year, month] = focus.split("-").map(Number);
      if (year && month) setVisibleMonth({ year, month: month - 1 });
    }
  }

  function pickCalendarDay(iso: string) {
    if (!draftStart || draftEnd) {
      setDraftStart(iso);
      setDraftEnd(null);
      return;
    }
    if (iso < draftStart) {
      setDraftEnd(draftStart);
      setDraftStart(iso);
      return;
    }
    setDraftEnd(iso);
  }

  function applyCalendar() {
    if (!draftStart) return;
    const start = draftEnd && draftEnd < draftStart ? draftEnd : draftStart;
    const end = draftEnd && draftEnd > draftStart ? draftEnd : draftStart;
    setApplied({ start, end });
    setRange(presetCovering(start));
    setCalendarOpen(false);
  }
  const modelSelect = (
    <OptionSelect
      size="sm"
      value={modelKey}
      onValueChange={(key) =>
        setSelectedModel(modelOptions.find((model) => model.key === key) ?? null)
      }
      aria-label={t`Model`}
      className="w-fit"
      options={[
        { value: "all", label: t`All models` },
        ...modelOptions.map((m) => ({ value: m.key, label: m.label })),
      ]}
    />
  );

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      data-testid="usage-settings"
      className="flex flex-col gap-6 outline-none"
    >
      <div className="flex flex-col items-stretch justify-between gap-4 md:flex-row md:items-center">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Popover open={calendarOpen} onOpenChange={openCalendar}>
            <PopoverTrigger className="inline-flex h-7 w-36 shrink-0 items-center justify-center rounded-[min(var(--radius-md),10px)] border border-input bg-transparent px-2.5 text-body-sm whitespace-nowrap text-foreground transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 dark:hover:bg-input/50">
              {rangeDates}
            </PopoverTrigger>
            <PopoverContent align="start" className="w-[246px] gap-3 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-body-sm font-medium text-foreground">{monthTitle}</span>
                <span className="flex items-center gap-1">
                  <button
                    type="button"
                    className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                    aria-label={t`Previous month`}
                    onClick={() =>
                      setVisibleMonth((current) =>
                        current.month === 0
                          ? { year: current.year - 1, month: 11 }
                          : { year: current.year, month: current.month - 1 },
                      )
                    }
                  >
                    <ChevronLeft className="size-4" />
                  </button>
                  <button
                    type="button"
                    className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                    aria-label={t`Next month`}
                    onClick={() =>
                      setVisibleMonth((current) =>
                        current.month === 11
                          ? { year: current.year + 1, month: 0 }
                          : { year: current.year, month: current.month + 1 },
                      )
                    }
                  >
                    <ChevronRight className="size-4" />
                  </button>
                </span>
              </div>
              <div className="grid grid-cols-7 gap-y-1 text-center text-caption text-muted-foreground">
                {weekdays.map((day, index) => (
                  <span key={`${day}-${index}`}>{day}</span>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-y-1">
                {monthCells(visibleMonth.year, visibleMonth.month).map((iso, index) => {
                  if (!iso) return <span key={`empty-${index}`} />;
                  const end = draftEnd ?? draftStart;
                  const inRange = Boolean(draftStart && end && iso >= draftStart && iso <= end);
                  const edge = iso === draftStart || iso === draftEnd;
                  return (
                    <button
                      key={iso}
                      type="button"
                      className={`mx-auto flex size-7 items-center justify-center rounded-md text-body-sm ${
                        edge
                          ? "bg-foreground text-background"
                          : inRange
                            ? "bg-accent text-foreground"
                            : "text-foreground hover:bg-accent"
                      }`}
                      onClick={() => pickCalendarDay(iso)}
                    >
                      {Number(iso.slice(8, 10))}
                    </button>
                  );
                })}
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  className="h-7 rounded-md px-2.5 text-body-sm text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => setCalendarOpen(false)}
                >
                  <Trans>Cancel</Trans>
                </button>
                <button
                  type="button"
                  className="h-7 rounded-md bg-foreground px-2.5 text-body-sm text-background disabled:opacity-50"
                  disabled={!draftStart}
                  onClick={applyCalendar}
                >
                  <Trans>Apply</Trans>
                </button>
              </div>
            </PopoverContent>
          </Popover>
          <OptionSelect
            size="sm"
            value={botId}
            onValueChange={(id) => setSelectedBot(bots.find((bot) => bot.id === id) ?? null)}
            aria-label={t`Bot`}
            className="w-fit"
            options={[
              { value: "all", label: t`All bots` },
              ...bots.map((bot) => ({
                value: bot.id,
                label:
                  bot.name == null
                    ? t`Deleted bot`
                    : bot.deleted
                      ? t`${bot.name} (deleted)`
                      : bot.name,
              })),
            ]}
          />
        </div>
        <ToggleGroup
          aria-label={t`Date range`}
          value={applied ? [] : [range]}
          onValueChange={([next]) => {
            if (!next) return;
            setApplied(null);
            setRange(next as UsageDateRange);
          }}
          size="sm"
          className="gap-1 bg-transparent p-0"
        >
          {ranges.map((r) => (
            <ToggleGroupItem
              key={r.id}
              value={r.id}
              className="rounded-md! bg-transparent px-2.5 text-body-sm text-muted-foreground aria-pressed:bg-foreground/15 aria-pressed:text-foreground"
            >
              {r.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {isError ? modelSelect : null}
      </div>

      <dl className="grid gap-3 sm:grid-cols-3">
        {[
          { label: t`Runs`, value: number(displayTotals?.runs) },
          { label: t`Tokens`, value: number(displayTotals?.totalTokens) },
          { label: t`Cost`, value: cost(displayTotals?.costUsd) },
        ].map((stat) => (
          <div key={stat.label} className="rounded-[12px] border border-border bg-card px-4 py-4">
            <dt className="text-body-sm text-muted-foreground">{stat.label}</dt>
            <dd className="mt-2 text-heading2 font-semibold tabular-nums text-foreground">
              {loading ? <UsageShimmer className="h-8 w-28 rounded-md" /> : stat.value}
            </dd>
          </div>
        ))}
      </dl>

      {fresh || loading ? (
        <div className="flex flex-col gap-4 rounded-[12px] bg-card p-6 shadow-[0_0_0_1px_var(--border)]">
          <div className="flex flex-col items-stretch justify-between gap-3 sm:flex-row sm:items-start">
            <div className="min-w-0">
              <SectionHeading variant="label">
                <Trans>Your usage</Trans>
              </SectionHeading>
              <p className="mt-1 text-body-sm text-muted-foreground">
                {monthly ? (
                  <Trans>Tokens per month in this range</Trans>
                ) : (
                  <Trans>Tokens per day in this range</Trans>
                )}
              </p>
            </div>
            {modelSelect}
          </div>
          {loading ? (
            <ChartShimmer />
          ) : hasTokens ? (
            <>
              <div className="flex w-full gap-2">
                <div className="flex h-56 w-9 shrink-0 flex-col justify-between text-right text-caption text-muted-foreground tabular-nums">
                  {axis.ticks.map((tick) => (
                    <span key={tick}>{formatAxisTokens(tick)}</span>
                  ))}
                </div>
                <div className="min-w-0 flex-1">
                  <div
                    className="relative grid h-56 w-full items-end"
                    style={{ gridTemplateColumns: `repeat(${chartPoints.length}, minmax(0, 1fr))` }}
                  >
                    {axis.ticks.map((tick) => (
                      <span
                        key={tick}
                        className="pointer-events-none absolute inset-x-0 border-t border-border/60"
                        style={{ bottom: `${(tick / axis.top) * 100}%` }}
                      />
                    ))}
                    {chartPoints.map((point) => {
                      const unknown = point.totalTokens == null;
                      const value = point.totalTokens ?? 0;
                      const height = unknown ? 100 : (value / axis.top) * 100;
                      const day = formatUsageDate(point.date, i18n.locale, monthly);
                      const unused = value === 0 && !unknown;
                      const barClass = `w-[18px] rounded-t-[3px] ${
                        unknown ? "bg-muted" : unused ? "bg-muted-foreground/40" : "bg-emerald-500"
                      }`;
                      if (unused || unknown) {
                        return (
                          <div
                            key={point.date}
                            className="flex h-full min-w-0 items-end justify-center"
                          >
                            <span
                              className={barClass}
                              style={{ height: unused ? "2px" : `${height}%` }}
                            />
                          </div>
                        );
                      }
                      const modelLine =
                        modelKey !== "all"
                          ? selectedModel?.label
                          : models.length === 1
                            ? models[0]?.model
                            : null;
                      return (
                        <div
                          key={point.date}
                          className="flex h-full min-w-0 items-end justify-center"
                        >
                          <Tooltip>
                            <TooltipTrigger
                              aria-label={t`${day}: ${number(value)} tokens`}
                              className="relative z-10 flex w-[18px] items-end focus-visible:outline-2 focus-visible:outline-ring"
                              style={{ height: `${height}%` }}
                            >
                              <span className={`${barClass} h-full`} />
                            </TooltipTrigger>
                            <TooltipContent
                              side="left"
                              sideOffset={8}
                              align="center"
                              arrow={false}
                              className="block w-auto flex-col items-stretch gap-1 bg-popover px-3 py-2 text-left text-popover-foreground shadow-md ring-1 ring-foreground/10"
                            >
                              <div className="text-body-sm font-medium text-foreground">{day}</div>
                              <div className="mt-1 flex items-center gap-2 text-caption">
                                <span className="size-2 rounded-full bg-emerald-500" />
                                <span>
                                  {modelLine ? `${modelLine}: ` : null}
                                  {number(value)}
                                </span>
                              </div>
                              <div className="mt-1 text-caption text-foreground">{t`Total: ${number(value)}`}</div>
                            </TooltipContent>
                          </Tooltip>
                        </div>
                      );
                    })}
                  </div>
                  <div className="relative mt-2 h-4">
                    {axisLabelIndexes(chartPoints.length).map((index) => {
                      const point = chartPoints[index];
                      if (!point) return null;
                      return (
                        <span
                          key={point.date}
                          className="absolute -translate-x-1/2 whitespace-nowrap text-caption text-muted-foreground"
                          style={{ left: `${((index + 0.5) / chartPoints.length) * 100}%` }}
                        >
                          {formatUsageDate(point.date, i18n.locale, monthly)}
                        </span>
                      );
                    })}
                  </div>
                </div>
              </div>
              <div className="mt-3 flex items-center gap-2 text-caption text-muted-foreground">
                <span className="size-2 rounded-full bg-emerald-500" />
                <Trans>Tokens</Trans>
              </div>
            </>
          ) : (
            <div className="py-8 text-center">
              <h3 className="text-body font-medium text-foreground">
                <Trans>Usage chart unavailable</Trans>
              </h3>
              <p className="mt-1 text-body-sm text-muted-foreground">
                <Trans>No usage for this period.</Trans>
              </p>
            </div>
          )}
        </div>
      ) : null}

      {loading ? (
        <span className="sr-only">
          <Trans>Loading usage…</Trans>
        </span>
      ) : models.length > 0 ? (
        <div className="rounded-[12px] bg-card px-2 shadow-[0_0_0_1px_var(--border)]">
          <Table className="text-body">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="text-muted-foreground">
                  <Trans>Model</Trans>
                </TableHead>
                <TableHead className="text-right text-muted-foreground">
                  <Trans>Calls</Trans>
                </TableHead>
                <TableHead className="text-right text-muted-foreground">
                  <Trans>Input</Trans>
                </TableHead>
                <TableHead className="text-right text-muted-foreground">
                  <Trans>Output</Trans>
                </TableHead>
                <TableHead className="text-right text-muted-foreground">
                  <Trans>Cost</Trans>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {models.map((row) => {
                const display = modelLabels.byKey.get(usageModelKey(row));
                const { modelLabel, providerLabel } = modelLabels.labelsFor(row);
                return (
                  <TableRow key={`${row.provider}:${row.model}`} className="hover:bg-transparent">
                    <TableCell>
                      <div className="text-foreground">{display?.label ?? modelLabel}</div>
                      {(display ? display.providerLabel : providerLabel) && (
                        <div className="text-label text-muted-foreground">
                          {display ? display.providerLabel : providerLabel}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {number(row.modelCalls)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {number(row.inputTokens)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {number(row.outputTokens)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{cost(row.costUsd)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : isError ? (
        <p className="text-body-sm text-muted-foreground">
          <Trans>Could not load usage.</Trans>
        </p>
      ) : !fresh ? (
        <p className="text-body-sm text-muted-foreground">
          <Trans>Loading usage…</Trans>
        </p>
      ) : (
        <p className="text-body-sm text-muted-foreground">
          <Trans>No usage for this selection.</Trans>
        </p>
      )}
    </div>
  );
}

const NO_CATALOG: ModelCatalogEntry[] = [];
