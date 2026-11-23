import { Trans, useLingui } from "@lingui/react/macro";
import { ORPCError } from "@orpc/client";
import type { BillingStatus, ByokInterval, ByokTier, HeldCreditAmount } from "@rakazo/contracts";
import {
  byokTierChangeOffered,
  byokYearlySwitchSavings,
  DEFAULT_MONTHLY_CREDIT_AMOUNT,
  HeldCreditAmountSchema,
  isCancelledTrial,
  MODEL_CREDIT_AMOUNTS,
  ModelCreditAmountSchema,
} from "@rakazo/contracts";
import { ownKeySubscriptionCents, subscribedTier, tierPriceCents } from "@rakazo/core";
import {
  billingDateLabel,
  formatBillingAmount,
  formatBillingDate,
  formatBillingPrice,
} from "@rakazo/i18n/billing";
import { tierComputerDescription, tierComputerSummary } from "@rakazo/i18n/computer-usage";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@rakazo/ui-web";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { analyticsSurface } from "../../lib/platform/desktop";
import { useSave } from "../../lib/query/query";
import type { RpcClient } from "../../lib/query/rpc";
import { ConfirmDialog } from "../ConfirmDialog";
import { ComputerUsage } from "./ComputerUsage";
import type { CreditAmount } from "./PlanControls";
import { ByokIntervalToggle, CreditAmountSelect } from "./PlanControls";

type TierOffer = NonNullable<BillingStatus["byokTiers"]>[number];

/** The own-key plan's tiers at `interval`, each with its price and computer. */
function ByokTierSelect({
  tiers,
  interval,
  value,
  disabled,
  onChange,
}: {
  tiers: TierOffer[];
  interval: ByokInterval;
  value: ByokTier;
  disabled?: boolean;
  onChange: (offer: TierOffer) => void;
}) {
  const { t, i18n } = useLingui();
  const offered = tiers.flatMap((offer) => {
    const cents = tierPriceCents(offer, interval);
    return cents === null
      ? []
      : [
          {
            offer,
            price: formatBillingPrice(
              { amount: cents, currency: "usd", interval, intervalCount: 1 },
              i18n.locale,
            ),
          },
        ];
  });
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        const chosen = offered.find(({ offer }) => offer.tier === next);
        if (chosen) onChange(chosen.offer);
      }}
      items={offered.map(({ offer }) => ({ value: offer.tier, label: offer.name }))}
    >
      <SelectTrigger aria-label={t`Plan`} className="min-w-28">
        <SelectValue />
      </SelectTrigger>
      <SelectContent
        alignItemWithTrigger={false}
        align="start"
        className="w-auto min-w-(--anchor-width)"
      >
        <SelectGroup>
          {offered.map(({ offer, price }) => (
            <SelectItem key={offer.tier} value={offer.tier} className="py-2">
              <span className="flex flex-col gap-0.5">
                <span>
                  {offer.name} · {price}
                </span>
                <span className="text-label text-muted-foreground">
                  {tierComputerSummary(offer)}
                </span>
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

/** The free period's subscribe button, at the chosen tier and interval. */
function SubscribeLabel({ price, annualPrice }: { price: string; annualPrice: string | null }) {
  return annualPrice ? (
    <Trans>Subscribe for {annualPrice} / year</Trans>
  ) : (
    <Trans>Subscribe for {price} / month</Trans>
  );
}

export function ModelCreditsSettings({
  status,
  refresh,
}: {
  status: BillingStatus;
  refresh: () => Promise<void>;
}) {
  const { t, i18n } = useLingui();
  const recurring =
    status.monthlyAmountCents && !["canceled", "none", "incomplete"].includes(status.state);
  const [chosenAmount, setChosenAmount] = useState<CreditAmount | null>(null);
  // Follows the plan until the owner picks an offered amount; only a live plan keeps a retired one.
  const amount: HeldCreditAmount =
    chosenAmount ??
    (recurring ? HeldCreditAmountSchema : ModelCreditAmountSchema)
      .catch(DEFAULT_MONTHLY_CREDIT_AMOUNT)
      .parse(status.monthlyAmountCents);
  const [topupAmount, setTopupAmount] = useState<CreditAmount>(MODEL_CREDIT_AMOUNTS[0]);
  const [purchaseOpen, setPurchaseOpen] = useState(false);
  const [interval, setByokInterval] = useState<ByokInterval>("month");
  const [endTrialOpen, setEndTrialOpen] = useState(false);
  const [yearlyOpen, setYearlyOpen] = useState(false);
  const [tierTarget, setTierTarget] = useState<TierOffer | null>(null);
  const [checkoutTier, setCheckoutTier] = useState<ByokTier>("standard");
  // Saves through the space the billing panel opened for, not the current selection.
  const change = useSave({
    save: (work: (client: RpcClient) => Promise<void>, client) => work(client),
  });
  const action = change.run;
  const pending = change.pending;
  const error = !change.error
    ? null
    : change.error instanceof ORPCError && change.error.status === 402
      ? "uncharged"
      : "failed";
  const balance = new Intl.NumberFormat(i18n.locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(status.balanceUsd ?? 0);
  const freeUntil = status.byokFreeUntil
    ? formatBillingDate(status.byokFreeUntil, i18n.locale || "en")
    : null;
  const price = status.byokPriceCents
    ? formatBillingAmount(status.byokPriceCents, "usd", i18n.locale)
    : null;
  const annualPrice = status.byokAnnualPriceCents
    ? formatBillingAmount(status.byokAnnualPriceCents, "usd", i18n.locale)
    : null;
  // A live subscription without monthly credits is the own-key plan, at the price it was bought at.
  const ownKeyCents = ownKeySubscriptionCents(status);
  const ownKeyPlan = ownKeyCents
    ? {
        price: formatBillingPrice(
          {
            amount: ownKeyCents,
            currency: "usd",
            interval: status.byokInterval ?? "month",
            intervalCount: 1,
          },
          i18n.locale,
        ),
        date: billingDateLabel(status, i18n.locale || "en"),
      }
    : null;
  const yearlySavings = byokYearlySwitchSavings(status);
  const tiers = status.byokTiers ?? [];
  const currentTier = subscribedTier(status);
  const tierChange = byokTierChangeOffered(status) && currentTier;
  const subscribedInterval = status.byokInterval ?? "month";
  const tierTargetName = tierTarget?.name;
  const tierTargetPrice = tierTarget && tierPriceCents(tierTarget, subscribedInterval);
  const tierTargetLabel = tierTargetPrice
    ? formatBillingPrice(
        {
          amount: tierTargetPrice,
          currency: "usd",
          interval: subscribedInterval,
          intervalCount: 1,
        },
        i18n.locale,
      )
    : null;
  // A free period subscribes at the tier it picks; without tiers, the plan's own prices apply.
  const checkoutOffer = tiers.find((offer) => offer.tier === checkoutTier);
  const checkoutMonthlyCents = checkoutOffer?.monthlyPriceCents ?? status.byokPriceCents;
  const checkoutAnnualCents = checkoutOffer
    ? checkoutOffer.annualPriceCents
    : status.byokAnnualPriceCents;
  const checkoutPrice = checkoutMonthlyCents
    ? formatBillingAmount(checkoutMonthlyCents, "usd", i18n.locale)
    : null;
  const checkoutAnnualPrice = checkoutAnnualCents
    ? formatBillingAmount(checkoutAnnualCents, "usd", i18n.locale)
    : null;
  return (
    <div data-testid="model-credits" className="space-y-5">
      {ownKeyPlan ? (
        <div data-testid="own-key-plan" className="rounded-xl border border-border p-5">
          <h3 className="text-body text-muted-foreground">
            <Trans>Your subscription or API key</Trans>
          </h3>
          <p className="mt-2 text-display font-medium tabular-nums">{ownKeyPlan.price}</p>
          {ownKeyPlan.date ? (
            <p className="mt-2 text-body text-muted-foreground">{ownKeyPlan.date}</p>
          ) : null}
          {currentTier ? (
            <p className="mt-2 text-body text-muted-foreground">
              {tierChange
                ? tierComputerDescription(currentTier)
                : `${currentTier.name} · ${tierComputerDescription(currentTier)}`}
            </p>
          ) : null}
          {tierChange || yearlySavings !== null ? (
            <div className="mt-5 flex flex-wrap items-center gap-3">
              {tierChange ? (
                <ByokTierSelect
                  tiers={tiers}
                  interval={subscribedInterval}
                  value={currentTier.tier}
                  disabled={pending}
                  onChange={(offer) => {
                    if (offer.tier !== currentTier.tier) setTierTarget(offer);
                  }}
                />
              ) : null}
              {yearlySavings !== null ? (
                <Button variant="secondary" disabled={pending} onClick={() => setYearlyOpen(true)}>
                  <Trans>Switch to yearly</Trans>
                  <span className="text-success">−{yearlySavings}%</span>
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="rounded-xl border border-border p-5">
        <div className="flex items-center justify-between">
          <h3 className="text-body text-muted-foreground">
            <Trans>Available credits</Trans>
          </h3>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t`Refresh credits`}
            disabled={pending}
            onClick={() => action(refresh)}
          >
            <RefreshCw />
          </Button>
        </div>
        <p className="mt-2 text-display font-medium tabular-nums">{balance}</p>
        <p className="mt-2 text-body text-muted-foreground">
          {status.funding === "byok" && freeUntil ? (
            <Trans>Using your API key. Free plan ends {freeUntil}.</Trans>
          ) : status.funding === "byok" ? (
            <Trans>Using your API key</Trans>
          ) : (
            <Trans>Monthly credits expire at renewal. Top-ups do not expire.</Trans>
          )}
        </p>
        {status.canManage ? (
          <div className="mt-5 flex flex-wrap items-center gap-3">
            {freeUntil && tiers.length > 1 ? (
              <ByokTierSelect
                tiers={tiers}
                interval={interval}
                value={checkoutTier}
                disabled={pending}
                onChange={(offer) => setCheckoutTier(offer.tier)}
              />
            ) : null}
            {freeUntil && checkoutMonthlyCents && checkoutAnnualCents ? (
              <ByokIntervalToggle
                monthlyCents={checkoutMonthlyCents}
                annualCents={checkoutAnnualCents}
                value={interval}
                onChange={setByokInterval}
              />
            ) : null}
            {freeUntil && checkoutPrice ? (
              <Button
                disabled={pending}
                onClick={() =>
                  action(async (client) => {
                    const { url } = await client.billing.checkout({
                      interval: checkoutAnnualPrice ? interval : "month",
                      ...(checkoutOffer ? { tier: checkoutTier } : {}),
                    });
                    window.location.assign(url);
                  })
                }
              >
                <SubscribeLabel
                  price={checkoutPrice}
                  annualPrice={interval === "year" ? checkoutAnnualPrice : null}
                />
              </Button>
            ) : null}
            <Button
              variant={freeUntil ? "secondary" : "default"}
              disabled={!status.creditPurchasesEnabled}
              onClick={() => setPurchaseOpen(true)}
            >
              <Trans>Add credits</Trans>
            </Button>
          </div>
        ) : null}
      </div>
      {status.computerHoursLeft != null ? (
        <div className="rounded-xl border border-border p-5">
          <h3 className="text-body text-muted-foreground">
            <Trans>Computer hours left</Trans>
          </h3>
          <p className="mt-2 text-display font-medium tabular-nums">{status.computerHoursLeft}</p>
          {status.computerHoursResetAt ? (
            <p className="mt-2 text-body text-muted-foreground">
              <Trans>
                Resets {formatBillingDate(status.computerHoursResetAt, i18n.locale || "en")}
              </Trans>
            </p>
          ) : null}
          {status.canManage ? (
            <ComputerUsage standardHours={status.standardComputerHours === true} />
          ) : null}
          {status.canManage && status.state === "trialing" && !status.cancelAtPeriodEnd ? (
            <>
              <p className="mt-2 text-body text-muted-foreground">
                <Trans>Trials get fewer hours to prevent abuse.</Trans>
              </p>
              <Button
                className="mt-5"
                variant="secondary"
                disabled={pending}
                onClick={() => setEndTrialOpen(true)}
              >
                <Trans>Start plan now</Trans>
              </Button>
            </>
          ) : isCancelledTrial(status) ? (
            <>
              <p className="mt-2 text-body text-muted-foreground">
                <Trans>Cancelled trials have no computer hours.</Trans>
              </p>
              {status.canManage && status.hasCustomer ? (
                <Button
                  className="mt-5"
                  variant="secondary"
                  disabled={pending}
                  onClick={() =>
                    action(async (client) => {
                      const { url } = await client.billing.portal();
                      window.location.assign(url);
                    })
                  }
                >
                  <Trans>Renew plan</Trans>
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
      <ConfirmDialog
        open={endTrialOpen}
        onCancel={() => setEndTrialOpen(false)}
        variant="default"
        title={<Trans>Start your plan now?</Trans>}
        description={
          price ? (
            <Trans>Your trial ends and your card is charged {price} today.</Trans>
          ) : (
            <Trans>Your trial ends and your card is charged today.</Trans>
          )
        }
        confirmDisabled={pending}
        onConfirm={() =>
          action(async (client) => {
            setEndTrialOpen(false);
            await client.billing.endTrial();
            await refresh();
          })
        }
        confirmLabel={<Trans>Start plan</Trans>}
      />
      <ConfirmDialog
        open={yearlyOpen}
        onCancel={() => setYearlyOpen(false)}
        variant="default"
        title={<Trans>Switch to yearly?</Trans>}
        description={
          status.state === "trialing" ? (
            <Trans>Your plan becomes {annualPrice} / year when your trial ends.</Trans>
          ) : (
            <Trans>
              Your card is charged {annualPrice} today, less the unused part of this month.
            </Trans>
          )
        }
        confirmDisabled={pending}
        onConfirm={() =>
          action(async (client) => {
            setYearlyOpen(false);
            await client.billing.switchToYearly();
            await refresh();
          })
        }
        confirmLabel={<Trans>Switch</Trans>}
      />
      <AlertDialog
        open={tierTarget !== null}
        onOpenChange={(open) => {
          if (!open) setTierTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Switch to {tierTargetName}?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              {status.state === "trialing" ? (
                <Trans>Your plan becomes {tierTargetLabel} when your trial ends.</Trans>
              ) : (tierTargetPrice ?? 0) > (status.byokPriceCents ?? 0) ? (
                <Trans>Your card is charged the prorated difference today.</Trans>
              ) : (
                <Trans>The unused difference is credited to your next invoice.</Trans>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={() =>
                action(async (client) => {
                  const tier = tierTarget?.tier;
                  setTierTarget(null);
                  if (!tier) return;
                  await client.billing.changeTier({ tier });
                  await refresh();
                })
              }
            >
              <Trans>Switch</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {status.canManage ? (
        <div className="rounded-xl border border-border p-5">
          <h3 className="font-medium">
            <Trans>Monthly credits</Trans>
          </h3>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <CreditAmountSelect
              monthly
              compact
              value={amount}
              onChange={(next) =>
                setChosenAmount(ModelCreditAmountSchema.safeParse(next).data ?? null)
              }
            />
            <Button
              variant="secondary"
              disabled={
                pending ||
                !status.creditPurchasesEnabled ||
                Boolean(recurring && amount === status.monthlyAmountCents)
              }
              onClick={() =>
                action(async (client) => {
                  if (recurring) {
                    await client.billing.setMonthlyCredits({
                      amountCents: ModelCreditAmountSchema.parse(amount),
                    });
                    await refresh();
                  } else {
                    const { url } = await client.billing.purchaseCredits({
                      amountCents: ModelCreditAmountSchema.parse(amount),
                      monthly: true,
                    });
                    window.location.assign(url);
                  }
                })
              }
            >
              {recurring ? (
                amount > (status.monthlyAmountCents ?? 0) ? (
                  <Trans>Upgrade now</Trans>
                ) : amount < (status.monthlyAmountCents ?? 0) ? (
                  <Trans>Downgrade at renewal</Trans>
                ) : (
                  <Trans>Update</Trans>
                )
              ) : (
                <Trans>Subscribe</Trans>
              )}
            </Button>
          </div>
          {status.hasCustomer ? (
            <Button
              className="mt-4"
              variant="ghost"
              disabled={pending}
              onClick={() =>
                action(async (client) => {
                  const { url } = await client.billing.portal();
                  window.location.assign(url);
                })
              }
            >
              <Trans>Manage billing</Trans>
            </Button>
          ) : null}
        </div>
      ) : null}
      {status.canManage && status.funding === "byok" && (status.balanceUsd ?? 0) > 0 ? (
        <Button
          variant="ghost"
          disabled={pending || !status.creditPurchasesEnabled}
          onClick={() =>
            action(async (client) => {
              await client.billing.selectFunding({
                funding: "credits",
                surface: analyticsSurface(),
              });
              window.location.reload();
            })
          }
        >
          <Trans>Use Rakazo credits</Trans>
        </Button>
      ) : null}
      {status.canManage && status.funding !== "byok" && (!recurring || status.cancelAtPeriodEnd) ? (
        <Button
          variant="ghost"
          disabled={pending}
          onClick={() =>
            action(async (client) => {
              const { url } = await client.billing.selectFunding({ funding: "byok" });
              window.location.assign(url ?? "/app?settings=models");
            })
          }
        >
          <Trans>Use my subscription or API key</Trans>
        </Button>
      ) : null}
      {error ? (
        <p role="alert" className="text-body text-destructive">
          {error === "uncharged" ? (
            <Trans>Your card was not charged</Trans>
          ) : (
            <Trans>Could not update billing</Trans>
          )}
        </p>
      ) : null}
      <Dialog open={purchaseOpen} onOpenChange={setPurchaseOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              <Trans>Add credits</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>One-time purchase. Credits do not expire.</Trans>
            </DialogDescription>
          </DialogHeader>
          <CreditAmountSelect
            value={topupAmount}
            onChange={(next) => setTopupAmount(ModelCreditAmountSchema.parse(next))}
          />
          <Button
            disabled={pending}
            onClick={() =>
              action(async (client) => {
                const { url } = await client.billing.purchaseCredits({
                  amountCents: topupAmount,
                  monthly: false,
                });
                window.location.assign(url);
              })
            }
          >
            <Trans>Continue to checkout</Trans>
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
