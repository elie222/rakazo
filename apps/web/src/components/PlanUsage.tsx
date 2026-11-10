import { useLingui } from "@lingui/react/macro";
import type { PlanLimits, PlanLimitWindow } from "@rakazo/contracts";
import { modelCreditsUsd, peakPlanUsage } from "@rakazo/contracts";
import { formatTimeUntil } from "@rakazo/core";
import { Progress } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useSpaceQueries } from "../lib/query";
import { useBilling } from "./SubscriptionGate";

/** Shared by the account menu and Settings > Usage; the server caches provider reads. */
export function usePlanUsage() {
  const queries = useSpaceQueries();
  const { status } = useBilling();
  const { data } = useQuery({ ...queries.usage.limits.queryOptions(), staleTime: 60_000 });
  const plans = data ?? [];
  return { plans, creditsUsd: modelCreditsUsd(status) };
}

function useFormatUsd() {
  const { i18n } = useLingui();
  return (value: number) =>
    new Intl.NumberFormat(i18n.locale, { style: "currency", currency: "USD" }).format(value);
}

/** What the account menu shows beside Usage, or null when there is nothing to watch. */
export function useUsageHint(): string | null {
  const { t } = useLingui();
  const { plans, creditsUsd } = usePlanUsage();
  const usd = useFormatUsd();
  const peak = peakPlanUsage(plans);
  if (peak !== null) return t`${Math.round(peak)}% used`;
  if (creditsUsd !== null) return t`${usd(creditsUsd)} left`;
  return null;
}

function WindowRow({ window }: { window: PlanLimitWindow }) {
  const { t, i18n } = useLingui();
  const label = { session: t`Session`, week: t`Weekly`, month: t`Monthly` }[window.period];
  const used = Math.round(window.usedPercent);
  const reset = formatTimeUntil(window.resetsAt, i18n.locale);
  return (
    <>
      <span className="text-body-sm text-muted-foreground">{label}</span>
      <Progress
        value={used}
        aria-label={label}
        className={used >= 90 ? "[&_[data-slot=progress-indicator]]:bg-destructive" : undefined}
      />
      <span className="text-body-sm tabular-nums text-foreground">
        {t`${used}% used`}
        {reset ? <span className="text-muted-foreground">{` · ${reset}`}</span> : null}
      </span>
    </>
  );
}

function PlanCard({ plan }: { plan: PlanLimits }) {
  return (
    <div data-testid="plan-limits" className="rounded-xl border border-border px-4 py-3">
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <span className="text-body font-medium text-foreground">{plan.name}</span>
        {plan.label !== plan.name ? (
          <span className="min-w-0 truncate text-body-sm text-muted-foreground">{plan.label}</span>
        ) : null}
      </div>
      <div className="grid grid-cols-[4.5rem_1fr_auto] items-center gap-x-3 gap-y-2">
        {plan.windows.map((window) => (
          <WindowRow key={window.period} window={window} />
        ))}
      </div>
    </div>
  );
}

/** Subscription allowances and the credit balance, each only when the member has it. */
export function PlanUsage() {
  const { t } = useLingui();
  const { plans, creditsUsd } = usePlanUsage();
  const usd = useFormatUsd();
  if (!plans.length && creditsUsd === null) return null;
  return (
    <div className="mb-4 flex flex-col gap-3">
      {plans.map((plan) => (
        <PlanCard key={plan.credentialId} plan={plan} />
      ))}
      {creditsUsd !== null ? (
        <div
          data-testid="credit-balance"
          className="flex items-baseline justify-between rounded-xl border border-border px-4 py-3"
        >
          <span className="text-body font-medium text-foreground">{t`Credits`}</span>
          <span className="text-body tabular-nums text-foreground">{t`${usd(creditsUsd)} left`}</span>
        </div>
      ) : null}
    </div>
  );
}
