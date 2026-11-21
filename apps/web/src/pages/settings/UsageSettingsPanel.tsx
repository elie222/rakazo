import { Trans, useLingui } from "@lingui/react/macro";
import type { ModelCatalogEntry, UsageBreakdownBot, UsageDateRange } from "@rakazo/contracts";
import {
  Field,
  FieldLabel,
  OptionSelect,
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
import type { RefObject } from "react";
import { useEffect, useState } from "react";
import { useSpaceQueries } from "../../lib/query/query";
import { usageModelKey, usageModelLabels } from "./usage-model-labels";

export function UsageSettingsPanel({ panelRef }: { panelRef?: RefObject<HTMLDivElement | null> }) {
  const { t, i18n } = useLingui();
  const queries = useSpaceQueries();
  const [range, setRange] = useState<UsageDateRange>("30d");
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
    { id: "today", label: t`Today` },
    { id: "7d", label: t`7 days` },
    { id: "30d", label: t`30 days` },
    { id: "all", label: t`All time` },
  ];

  // The lists keep the previous result while the next one loads; the numbers never do, nor after a failed read.
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

  const maxTokens = Math.max(1, ...overTime.map((p) => p.totalTokens ?? 0));

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      data-testid="usage-settings"
      className="space-y-4 outline-none"
    >
      <div className="flex flex-wrap items-end gap-3">
        <Field className="min-w-[180px] flex-1">
          <FieldLabel>
            <Trans>Bot</Trans>
          </FieldLabel>
          <OptionSelect
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
        </Field>
        <Field className="min-w-[180px] flex-1">
          <FieldLabel>
            <Trans>Model</Trans>
          </FieldLabel>
          <OptionSelect
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
        </Field>
        <Field className="min-w-[220px]">
          <FieldLabel>
            <Trans>Date range</Trans>
          </FieldLabel>
          <ToggleGroup
            aria-label={t`Date range`}
            value={[range]}
            onValueChange={([next]) => {
              if (next) setRange(next as UsageDateRange);
            }}
            spacing={1}
            className="grid grid-cols-4 rounded-lg bg-muted p-1"
          >
            {ranges.map((r) => (
              <ToggleGroupItem
                key={r.id}
                value={r.id}
                className="text-body-sm aria-pressed:bg-background aria-pressed:shadow-sm"
              >
                {r.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Field>
      </div>

      <dl className="grid grid-cols-3 gap-3">
        {[
          { label: t`Runs`, value: number(totals?.runs) },
          { label: t`Tokens`, value: number(totals?.totalTokens) },
          { label: t`Cost`, value: cost(totals?.costUsd) },
        ].map((stat) => (
          <div key={stat.label} className="rounded-xl border border-border px-4 py-3">
            <dt className="text-body-sm text-muted-foreground">{stat.label}</dt>
            <dd className="mt-1 text-heading3 font-medium tabular-nums text-foreground">
              {stat.value}
            </dd>
          </div>
        ))}
      </dl>

      {overTime.length > 0 ? (
        <div className="rounded-xl border border-border px-4 py-3">
          <SectionHeading variant="label" className="mb-3">
            <Trans>Usage over time</Trans>
          </SectionHeading>
          <div className="flex h-28 items-end gap-1">
            {overTime.map((point, index) => {
              const unknown = point.totalTokens == null;
              const value = point.totalTokens ?? 0;
              const height = unknown
                ? 100
                : value === 0
                  ? 0
                  : Math.max(4, Math.round((value / maxTokens) * 100));
              const day = new Date(`${point.date}T00:00:00Z`).toLocaleDateString(
                i18n.locale,
                monthly
                  ? { month: "short", year: "numeric", timeZone: "UTC" }
                  : { month: "short", day: "numeric", timeZone: "UTC" },
              );
              const labelled = overTime.length <= 8 || index === 0 || index === overTime.length - 1;
              const label = t`${day}: ${number(point.totalTokens)} tokens, ${cost(point.costUsd)}`;
              return (
                <Tooltip key={point.date}>
                  <TooltipTrigger
                    aria-label={label}
                    className="flex h-full min-w-0 flex-1 flex-col items-center gap-1 rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <span className="flex w-full flex-1 items-end">
                      <span
                        className={`w-full rounded-sm ${unknown ? "bg-muted" : "bg-foreground/70"}`}
                        style={{ height: `${height}%` }}
                      />
                    </span>
                    <span className="w-full truncate text-center text-caption text-muted-foreground">
                      {labelled ? day : null}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>{label}</TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        </div>
      ) : null}

      {models.length > 0 ? (
        <div className="rounded-xl border border-border px-2">
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
