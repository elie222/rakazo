import { Trans, useLingui } from "@lingui/react/macro";
import type { BillingStatus, ByokInterval } from "@rakazo/contracts";
import { DEFAULT_MONTHLY_CREDIT_AMOUNT, ModelCreditAmountSchema } from "@rakazo/contracts";
import { formatBillingAmount, formatMonthlyPrice } from "@rakazo/i18n/billing";
import { bestEffort } from "@rakazo/logging/best-effort";
import { Button, Card, CardContent, CardFooter, CardHeader } from "@rakazo/ui-web";
import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useSignOut } from "../../lib/auth/sign-out";
import { desktopBridge } from "../../lib/platform/desktop";
import type { RpcClient } from "../../lib/query/rpc";
import { rpc } from "../../lib/query/rpc";
import { AccountMenu } from "../account/AccountMenu";
import { InfoTooltip } from "../InfoTooltip";
import type { CreditAmount } from "./PlanControls";
import { ByokIntervalToggle, CreditAmountSelect } from "./PlanControls";

/** A checked line on a plan, with more about it behind an info button when it needs it. */
type PlanFeature = string | { text: string; info: { label: string; text: string } };

/** One plan to choose: its name, price, what it includes and the button that picks it. */
function PlanCard({
  title,
  price,
  detail,
  features,
  action,
  highlighted = false,
}: {
  title: ReactNode;
  price: ReactNode;
  detail?: ReactNode;
  features: PlanFeature[];
  action: ReactNode;
  highlighted?: boolean;
}) {
  return (
    <Card className={highlighted ? "ring-2 ring-primary" : undefined}>
      <CardHeader>
        <h2 className="text-heading3 font-medium">{title}</h2>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4">
        {price}
        {detail ? <p className="text-body text-muted-foreground">{detail}</p> : null}
        <ul className="space-y-3 text-body">
          {features.map((feature) => {
            const text = typeof feature === "string" ? feature : feature.text;
            return (
              <li key={text} className="flex gap-2">
                <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span>{text}</span>
                {typeof feature === "string" ? null : (
                  <InfoTooltip label={feature.info.label}>{feature.info.text}</InfoTooltip>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
      <CardFooter className="border-t-0 bg-transparent">{action}</CardFooter>
    </Card>
  );
}

/** "$12 / month", the way a plan card shows its price. */
function MonthlyPrice({ cents }: { cents: number }) {
  const { i18n } = useLingui();
  return (
    <p className="flex items-baseline gap-1">
      <span className="text-display font-medium tracking-tight">
        {formatBillingAmount(cents, "usd", i18n.locale)}
      </span>
      <span className="text-body text-muted-foreground">
        <Trans>/ month</Trans>
      </span>
    </p>
  );
}

export function CreditChoice({
  status,
  client,
  dismissible = false,
}: {
  status: BillingStatus;
  client: RpcClient;
  dismissible?: boolean;
}) {
  const { t, i18n } = useLingui();
  const features = [
    t`Bots and browser automation`,
    t`Scheduled routines`,
    t`Web, desktop and mobile`,
  ];
  const trialDays = status.trialDays;
  const [amount, setAmount] = useState<CreditAmount>(DEFAULT_MONTHLY_CREDIT_AMOUNT);
  const [interval, setByokInterval] = useState<ByokInterval>("month");
  const credit = formatBillingAmount(amount, "usd", i18n.locale);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { logOut, signingOut } = useSignOut("/sign-in", setError);
  // A choice that answers after the plans were closed must not leave the app.
  const closed = useRef(false);
  useEffect(() => {
    closed.current = false;
    return () => {
      closed.current = true;
    };
  }, []);
  function go(url: string) {
    if (!closed.current) window.location.assign(url);
  }
  // Reported once, as first shown, and only when required: opened from the app it is not a
  // first plan choice.
  useEffect(() => {
    if (dismissible) return;
    void bestEffort(
      "report the plans screen",
      Promise.resolve().then(() =>
        rpc.analytics.screen({
          screen: "plans",
          surface: desktopBridge() ? "desktop" : "web",
        }),
      ),
    );
  }, []);
  async function choose(ownKey: boolean) {
    setPending(true);
    setError(null);
    const terms = { interval };
    try {
      if (ownKey && status.byokFreeUntil) {
        go((await client.billing.checkout(terms)).url);
      } else if (ownKey) {
        const { url } = await client.billing.selectFunding({ funding: "byok", ...terms });
        go(url ?? "/onboarding");
      } else {
        const { url } = await client.billing.purchaseCredits({
          amountCents: amount,
          monthly: true,
        });
        go(url);
      }
    } catch {
      setError(t`Could not open billing`);
    } finally {
      // Desktop opens the URL in the system browser and this page stays, so re-enable.
      setPending(false);
    }
  }
  return (
    <div
      data-testid="billing-paywall"
      className="mx-auto flex min-h-dvh max-w-3xl flex-col justify-center gap-8 px-6 py-12"
    >
      {dismissible ? null : (
        <AccountMenu disabled={pending} signingOut={signingOut} onLogOut={() => void logOut()} />
      )}
      <h1 className="text-heading1 font-medium">
        <Trans>Choose how to use Rakazo</Trans>
      </h1>
      <div className="grid gap-4 min-[480px]:grid-cols-2">
        <PlanCard
          title={<Trans>Your subscription or API key</Trans>}
          price={
            status.byokPriceCents && status.byokAnnualPriceCents ? (
              <div className="flex h-12 items-center justify-between gap-3">
                <MonthlyPrice
                  cents={
                    interval === "year"
                      ? Math.round(status.byokAnnualPriceCents / 12)
                      : status.byokPriceCents
                  }
                />
                <ByokIntervalToggle
                  monthlyCents={status.byokPriceCents}
                  annualCents={status.byokAnnualPriceCents}
                  value={interval}
                  onChange={setByokInterval}
                />
              </div>
            ) : (
              <p className="flex h-12 items-center text-display font-medium tracking-tight">
                {status.byokPriceCents ? (
                  formatMonthlyPrice(status.byokPriceCents, i18n.locale)
                ) : (
                  <Trans>Free</Trans>
                )}
              </p>
            )
          }
          detail={<Trans>Works with your ChatGPT or Claude plan.</Trans>}
          features={features}
          action={
            <Button
              className="w-full bg-background dark:bg-transparent"
              variant="outline"
              disabled={pending || !status.canManage}
              aria-label={
                status.byokPriceCents && !status.trialAvailable
                  ? t`Subscribe with your own AI`
                  : undefined
              }
              onClick={() => void choose(true)}
            >
              {!status.byokPriceCents ? (
                <Trans>Connect my own</Trans>
              ) : status.trialAvailable ? (
                <Trans>Start {trialDays}-day free trial</Trans>
              ) : (
                <Trans>Subscribe</Trans>
              )}
            </Button>
          }
        />
        <PlanCard
          title={<Trans>Credits</Trans>}
          price={
            <CreditAmountSelect
              monthly
              value={amount}
              onChange={(next) => setAmount(ModelCreditAmountSchema.parse(next))}
            />
          }
          detail={<Trans>All {credit} goes to model usage.</Trans>}
          features={[...features, t`Models at provider cost`]}
          action={
            <Button
              className="w-full"
              disabled={pending || !status.canManage || !status.creditPurchasesEnabled}
              aria-label={t`Subscribe to credits`}
              onClick={() => void choose(false)}
            >
              <Trans>Subscribe</Trans>
            </Button>
          }
        />
      </div>
      {error ? (
        <p role="alert" className="text-body text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
