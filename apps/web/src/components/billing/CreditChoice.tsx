import { Trans, useLingui } from "@lingui/react/macro";
import type { BillingStatus, ByokInterval, ByokTier } from "@rakazo/contracts";
import {
  COMPUTER_SIZE_SPECS,
  DEFAULT_MONTHLY_CREDIT_AMOUNT,
  ModelCreditAmountSchema,
} from "@rakazo/contracts";
import { formatBillingAmount } from "@rakazo/i18n/billing";
import { tierComputerDescription } from "@rakazo/i18n/computer-usage";
import { Button, Card, CardContent, CardFooter, CardHeader } from "@rakazo/ui-web";
import { cn } from "@rakazo/ui-web/lib/utils";
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
import { ByokIntervalToggle, CreditAmountSelect, formatMonthlyUsd } from "./PlanControls";

type TierOffer = NonNullable<BillingStatus["byokTiers"]>[number];
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

/** The own-key plan's tiers side by side, Standard first, with monthly credits below. */
function TierPlans({
  status,
  tiers,
  features,
  interval,
  onIntervalChange,
  amount,
  onAmountChange,
  pending,
  choose,
}: {
  status: BillingStatus;
  tiers: TierOffer[];
  features: string[];
  interval: ByokInterval;
  onIntervalChange: (interval: ByokInterval) => void;
  amount: CreditAmount;
  onAmountChange: (amount: CreditAmount) => void;
  pending: boolean;
  choose: (ownKey: boolean, plan?: { tier: ByokTier; interval: ByokInterval }) => void;
}) {
  const { t, i18n } = useLingui();
  const [first] = tiers;
  /** A bigger tier's computer as a multiple of the first's, so the cards compare without specs. */
  const power = (offer: TierOffer, base: TierOffer) => {
    const times =
      COMPUTER_SIZE_SPECS[offer.computerSize].vcpus / COMPUTER_SIZE_SPECS[base.computerSize].vcpus;
    return offer.computerSizeChoice
      ? t`Up to ${times}× the vCPUs`
      : t`A ${times}× more powerful computer for your bot`;
  };
  const powerDetail = (offer: TierOffer, base: TierOffer) => {
    const { memoryGb } = COMPUTER_SIZE_SPECS[offer.computerSize];
    const usage = Math.round(offer.computerHours / base.computerHours);
    if (offer.computerSizeChoice) return tierComputerDescription(offer);
    return t`${memoryGb} GB of RAM and ${usage}× the computer time of ${base.name}. Time counts only while your bot uses its computer.`;
  };
  const credit = formatBillingAmount(amount, "usd", i18n.locale);
  const trialDays = status.trialDays;
  return (
    <>
      <div className="-mt-4 flex flex-col items-center gap-6 text-center">
        <p className="text-body text-muted-foreground">
          <Trans>Works with your ChatGPT or Claude plan, or an API key.</Trans>
        </p>
        {first?.annualPriceCents ? (
          <ByokIntervalToggle
            monthlyCents={first.monthlyPriceCents}
            annualCents={first.annualPriceCents}
            value={interval}
            onChange={onIntervalChange}
          />
        ) : null}
      </div>
      <div className="grid gap-4 min-[640px]:grid-cols-3">
        {tiers.map((offer, index) => {
          const yearly = interval === "year" && offer.annualPriceCents !== null;
          const monthlyCents = yearly
            ? Math.round(offer.annualPriceCents! / 12)
            : offer.monthlyPriceCents;
          const name = offer.name;
          return (
            <PlanCard
              key={offer.tier}
              highlighted={index === 0}
              title={name}
              price={<MonthlyPrice cents={monthlyCents} />}
              features={
                index === 0 || !first
                  ? features
                  : [
                      t`Everything in ${first.name}`,
                      {
                        text: power(offer, first),
                        info: { label: offer.name, text: powerDetail(offer, first) },
                      },
                    ]
              }
              action={
                <Button
                  className={index === 0 ? "w-full" : "w-full bg-background dark:bg-transparent"}
                  variant={index === 0 ? "default" : "outline"}
                  disabled={pending || !status.canManage}
                  aria-label={
                    status.trialAvailable ? t`Start ${name} trial` : t`Subscribe to ${name}`
                  }
                  onClick={() =>
                    choose(true, { tier: offer.tier, interval: yearly ? "year" : "month" })
                  }
                >
                  {status.trialAvailable ? (
                    <Trans>Start {trialDays}-day free trial</Trans>
                  ) : (
                    <Trans>Subscribe</Trans>
                  )}
                </Button>
              }
            />
          );
        })}
      </div>
      <Card>
        <CardContent className="flex flex-col gap-4 min-[640px]:flex-row min-[640px]:items-center">
          <div className="flex-1">
            <h2 className="text-heading3 font-medium">
              <Trans>No plan or key? Use credits</Trans>
            </h2>
            <p className="mt-1 text-body text-muted-foreground">
              <Trans>All {credit} goes to model usage.</Trans>
            </p>
          </div>
          <div className="min-[640px]:w-44">
            <CreditAmountSelect
              monthly
              compact
              value={amount}
              onChange={(next) => onAmountChange(ModelCreditAmountSchema.parse(next))}
            />
          </div>
          <Button
            className="bg-background min-[640px]:w-32 dark:bg-transparent"
            variant="outline"
            disabled={pending || !status.canManage || !status.creditPurchasesEnabled}
            aria-label={t`Subscribe to credits`}
            onClick={() => choose(false)}
          >
            <Trans>Subscribe</Trans>
          </Button>
        </CardContent>
      </Card>
    </>
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
  // Keep the plan-layout experiment's offers fixed. Ultra is offered in Billing.
  const tiers =
    status.planLayout === "tiers"
      ? (status.byokTiers ?? []).filter((offer) => offer.tier !== "ultra")
      : [];
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
    void Promise.resolve()
      .then(() =>
        rpc.analytics.screen({
          screen: "plans",
          surface: desktopBridge() ? "desktop" : "web",
          ...(status.planLayout ? { planLayout: status.planLayout } : {}),
        }),
      )
      .catch(() => undefined);
  }, []);
  async function choose(ownKey: boolean, plan?: { tier: ByokTier; interval: ByokInterval }) {
    setPending(true);
    setError(null);
    const terms = plan ?? { interval };
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
      <h1 className={cn("text-heading1 font-medium", tiers.length > 1 && "text-center")}>
        <Trans>Choose how to use Rakazo</Trans>
      </h1>
      {tiers.length > 1 ? (
        <TierPlans
          status={status}
          tiers={tiers}
          features={features}
          interval={interval}
          onIntervalChange={setByokInterval}
          amount={amount}
          onAmountChange={setAmount}
          pending={pending}
          choose={choose}
        />
      ) : (
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
                    formatMonthlyUsd(status.byokPriceCents, i18n.locale)
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
      )}
      {error ? (
        <p role="alert" className="text-body text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
