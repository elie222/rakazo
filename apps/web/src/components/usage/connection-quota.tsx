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
  const { t } = useLingui();
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
  const observation = quota.data;
  return (
    <section
      aria-label={label ?? t`Quota`}
      className={compact ? "space-y-2" : "space-y-3"}
      data-testid="connection-quota"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">{label ?? <Trans>Quota</Trans>}</h3>
          {accountLabel ? (
            <p className="truncate text-xs text-muted-foreground">{accountLabel}</p>
          ) : null}
        </div>
        {!compact ? (
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
                if (observation?.observedAt)
                  client.setQueryData(queries.models.quota.queryKey(quotaInput), {
                    ...observation,
                    status: "stale",
                  });
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
        <p className="text-sm text-muted-foreground">
          <Trans>Loading</Trans>
        </p>
      ) : null}
      {quota.isError ||
      observation?.status === "unavailable" ||
      observation?.status === "unsupported" ? (
        <p className="text-sm text-muted-foreground" role="status">
          <Trans>Quota unavailable</Trans>
        </p>
      ) : null}
      {observation?.status === "stale" ? (
        <p className="text-sm text-warning" role="status">
          <Trans>Last known usage</Trans>
        </p>
      ) : null}
      {observation?.windows.map((window) => (
        <QuotaWindow key={window.id} window={window} compact={compact} />
      ))}
      {!compact && observation?.observedAt ? (
        <p className="text-xs text-muted-foreground">
          <Trans>Updated</Trans>{" "}
          <time dateTime={observation.observedAt}>
            {new Date(observation.observedAt).toLocaleString()}
          </time>
        </p>
      ) : null}
    </section>
  );
}

function QuotaWindow({ window, compact }: { window: ModelQuotaWindow; compact: boolean }) {
  const { t } = useLingui();
  const remaining = Math.round((100 - window.usedPercent) * 10) / 10;
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
      <div className={`flex justify-between gap-3 ${compact ? "text-xs" : "text-sm"}`}>
        <span className="min-w-0 truncate">
          {label}
          {compact && window.resetsAt ? (
            <time
              className="ms-2 text-muted-foreground"
              dateTime={window.resetsAt}
              title={`${t`Resets`} ${new Date(window.resetsAt).toLocaleString()}`}
            >
              <span className="sr-only">
                <Trans>Resets</Trans>{" "}
              </span>
              {new Date(window.resetsAt).toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
            </time>
          ) : null}
        </span>
        <span
          className={remaining === 0 ? "text-destructive" : "text-foreground"}
        >{t`${remaining}% remaining`}</span>
      </div>
      <meter
        min={0}
        max={100}
        value={remaining}
        aria-label={label}
        className="h-2 w-full appearance-none [&::-moz-meter-bar]:bg-foreground [&::-webkit-meter-bar]:border-0 [&::-webkit-meter-bar]:bg-muted [&::-webkit-meter-bar]:bg-none [&::-webkit-meter-optimum-value]:bg-foreground [&::-webkit-meter-optimum-value]:bg-none"
      />
      {!compact && window.resetsAt ? (
        <p className="text-xs text-muted-foreground">
          <Trans>Resets</Trans>{" "}
          <time dateTime={window.resetsAt}>{new Date(window.resetsAt).toLocaleString()}</time>
        </p>
      ) : null}
    </div>
  );
}
