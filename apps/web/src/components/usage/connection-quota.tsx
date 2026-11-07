import { Trans, useLingui } from "@lingui/react/macro";
import type { ModelQuotaWindow } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSpaceQueries } from "../../lib/query";
import { useSpaceRpc } from "../../lib/space-rpc";

/** Read-only allowance shared by the Usage page and its menu preview. */
export function ConnectionQuota({
  credentialId,
  label,
  compact = false,
  accountLabel,
}: {
  credentialId: string;
  label?: string;
  compact?: boolean;
  accountLabel?: string;
}) {
  const { t, i18n } = useLingui();
  const queries = useSpaceQueries();
  const client = useQueryClient();
  const rpc = useSpaceRpc();
  const [refreshing, setRefreshing] = useState(false);
  const quotaInput = { input: { credentialId } };
  const quota = useQuery({
    ...queries.models.quota.queryOptions(quotaInput),
    refetchInterval: 60_000,
    retry: false,
  });
  // A failed background poll keeps the last reading, so show it as stale rather than unavailable.
  const observation =
    quota.isError && quota.data?.observedAt
      ? { ...quota.data, status: "stale" as const }
      : quota.data;
  return (
    <section
      aria-label={label ?? t`Quota`}
      className={compact ? "space-y-2" : "space-y-3"}
      data-testid="connection-quota"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-body font-medium">{label ?? <Trans>Quota</Trans>}</h3>
          {accountLabel ? (
            <p className="truncate text-label text-muted-foreground">{accountLabel}</p>
          ) : null}
        </div>
        {!compact && observation?.status !== "unsupported" ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={quota.isFetching || refreshing}
            onClick={async () => {
              setRefreshing(true);
              try {
                const result = await rpc.models.quota({ credentialId, fresh: true });
                client.setQueryData(queries.models.quota.queryKey(quotaInput), result);
              } catch {
                client.setQueryData(queries.models.quota.queryKey(quotaInput), (current) =>
                  current?.observedAt ? { ...current, status: "stale" as const } : current,
                );
              } finally {
                setRefreshing(false);
              }
            }}
          >
            <Trans>Refresh</Trans>
          </Button>
        ) : null}
      </div>
      {quota.isPending ? (
        <p className="text-body text-muted-foreground">
          <Trans>Loading</Trans>
        </p>
      ) : null}
      {(quota.isError && !observation) || observation?.status === "unavailable" ? (
        <p className="text-body text-muted-foreground" role="status">
          <Trans>Quota unavailable</Trans>
        </p>
      ) : null}
      {observation?.status === "stale" ? (
        <p className="text-body text-warning" role="status">
          <Trans>Last known usage</Trans>
        </p>
      ) : null}
      {observation?.windows.map((window) => (
        <QuotaWindow key={window.id} window={window} compact={compact} />
      ))}
      {!compact && observation?.observedAt ? (
        <p className="text-label text-muted-foreground">
          <Trans>Updated</Trans>{" "}
          <time dateTime={observation.observedAt}>
            {new Date(observation.observedAt).toLocaleString(i18n.locale)}
          </time>
        </p>
      ) : null}
    </section>
  );
}

function QuotaWindow({ window, compact }: { window: ModelQuotaWindow; compact: boolean }) {
  const { t, i18n } = useLingui();
  const left = Math.round((100 - window.usedPercent) * 10) / 10;
  const remaining = new Intl.NumberFormat(i18n.locale).format(left);
  const label =
    window.id === "five_hour"
      ? t`Session`
      : window.id === "seven_day"
        ? t`Weekly`
        : window.id === "monthly"
          ? t`Monthly`
          : window.id === "primary_window" || window.id === "secondary_window"
            ? t`Allowance`
            : window.id;
  return (
    <div className="space-y-1">
      <div className={`flex justify-between gap-3 ${compact ? "text-label" : "text-body"}`}>
        <span className="min-w-0 truncate">
          {label}
          {compact && window.resetsAt ? (
            <time
              className="ms-2 text-muted-foreground"
              dateTime={window.resetsAt}
              title={`${t`Resets`} ${new Date(window.resetsAt).toLocaleString(i18n.locale)}`}
            >
              <span className="sr-only">
                <Trans>Resets</Trans>{" "}
              </span>
              {new Date(window.resetsAt).toLocaleString(i18n.locale, {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
            </time>
          ) : null}
        </span>
        <span
          className={left === 0 ? "text-destructive" : "text-foreground"}
        >{t`${remaining}% remaining`}</span>
      </div>
      <meter
        min={0}
        max={100}
        value={left}
        aria-label={label}
        className="h-2 w-full appearance-none [&::-moz-meter-bar]:bg-foreground [&::-webkit-meter-bar]:border-0 [&::-webkit-meter-bar]:bg-muted [&::-webkit-meter-bar]:bg-none [&::-webkit-meter-optimum-value]:bg-foreground [&::-webkit-meter-optimum-value]:bg-none"
      />
      {!compact && window.resetsAt ? (
        <p className="text-label text-muted-foreground">
          <Trans>Resets</Trans>{" "}
          <time dateTime={window.resetsAt}>
            {new Date(window.resetsAt).toLocaleString(i18n.locale)}
          </time>
        </p>
      ) : null}
    </div>
  );
}
