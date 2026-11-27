import { Trans, useLingui } from "@lingui/react/macro";
import type {
  BillingStatus,
  ByokInterval,
  ByokTier,
  HeldCreditAmount,
  MODEL_CREDIT_AMOUNTS,
} from "@rakazo/contracts";
import {
  ByokIntervalSchema,
  byokYearlySavingsPercent,
  creditAmountChoices,
  HeldCreditAmountSchema,
} from "@rakazo/contracts";
import { tierPriceCents } from "@rakazo/core";
import { formatBillingAmount, formatBillingPrice, formatMonthlyPrice } from "@rakazo/i18n/billing";
import { tierComputerSummary } from "@rakazo/i18n/computer-usage";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  ToggleGroup,
  ToggleGroupItem,
} from "@rakazo/ui-web";

export type CreditAmount = (typeof MODEL_CREDIT_AMOUNTS)[number];

type TierOffer = NonNullable<BillingStatus["byokTiers"]>[number];

/** The own-key plan's tiers at `interval`, each with its price and computer. */
export function ByokTierSelect({
  tiers,
  interval,
  value,
  disabled,
  onChange,
  wide = false,
}: {
  tiers: TierOffer[];
  interval: ByokInterval;
  value: ByokTier;
  disabled?: boolean;
  onChange: (offer: TierOffer) => void;
  /** Fills a plan card at the credits picker's height, showing the chosen price per month. */
  wide?: boolean;
}) {
  const { t, i18n } = useLingui();
  const offered = tiers.flatMap((offer) => {
    const cents = tierPriceCents(offer, interval);
    if (cents === null) return [];
    const price = wide
      ? formatMonthlyPrice(interval === "year" ? Math.round(cents / 12) : cents, i18n.locale)
      : formatBillingPrice(
          { amount: cents, currency: "usd", interval, intervalCount: 1 },
          i18n.locale,
        );
    return [{ offer, price }];
  });
  const chosen = offered.find(({ offer }) => offer.tier === value);
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        const picked = offered.find(({ offer }) => offer.tier === next);
        if (picked) onChange(picked.offer);
      }}
      items={offered.map(({ offer }) => ({ value: offer.tier, label: offer.name }))}
    >
      <SelectTrigger
        aria-label={t`Plan`}
        size={wide ? "xl" : "default"}
        className={wide ? "w-full" : "min-w-28"}
      >
        {wide && chosen ? (
          <span className="flex flex-1 justify-between gap-3">
            <span>{chosen.offer.name}</span>
            <span className="text-muted-foreground">{chosen.price}</span>
          </span>
        ) : (
          <SelectValue />
        )}
      </SelectTrigger>
      <SelectContent
        alignItemWithTrigger={false}
        align="start"
        className="w-auto min-w-(--anchor-width)"
      >
        <SelectGroup>
          {offered.map(({ offer, price }) => (
            <SelectItem key={offer.tier} value={offer.tier} className="py-2">
              <span className="flex flex-1 flex-col gap-0.5">
                <span className="flex justify-between gap-4">
                  <span>{offer.name}</span>
                  <span className="text-muted-foreground">{price}</span>
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

/** Monthly or yearly own-key plan, with what the yearly plan saves. */
export function ByokIntervalToggle({
  monthlyCents,
  annualCents,
  value,
  onChange,
}: {
  monthlyCents: number;
  annualCents: number;
  value: ByokInterval;
  onChange: (interval: ByokInterval) => void;
}) {
  const { t } = useLingui();
  const savings = byokYearlySavingsPercent(monthlyCents, annualCents);
  return (
    <ToggleGroup
      aria-label={t`Billing period`}
      value={[value]}
      onValueChange={([next]) => {
        if (next) onChange(ByokIntervalSchema.parse(next));
      }}
      spacing={1}
      variant="segmented"
      size="sm"
      className="shrink-0 data-[variant=segmented]:bg-foreground/5"
    >
      <ToggleGroupItem value="month">
        <Trans>Monthly</Trans>
      </ToggleGroupItem>
      <ToggleGroupItem value="year">
        <Trans>Yearly</Trans>
        {savings > 0 ? <span className="text-success">−{savings}%</span> : null}
      </ToggleGroupItem>
    </ToggleGroup>
  );
}

export function CreditAmountSelect({
  value,
  onChange,
  monthly = false,
  compact = false,
}: {
  value: HeldCreditAmount;
  onChange: (amount: HeldCreditAmount) => void;
  monthly?: boolean;
  /** As tall as the buttons around it, for a row of controls. */
  compact?: boolean;
}) {
  const { t, i18n } = useLingui();
  const items = creditAmountChoices(value).map((amount) => ({
    value: amount,
    label: monthly
      ? formatMonthlyPrice(amount, i18n.locale)
      : formatBillingAmount(amount, "usd", i18n.locale),
  }));
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next !== null) onChange(HeldCreditAmountSchema.parse(next));
      }}
      items={items}
    >
      <SelectTrigger
        aria-label={monthly ? t`Monthly credits` : t`Credit amount`}
        size={compact ? "default" : "xl"}
        className="w-full"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} align="start">
        <SelectGroup>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value} className="py-2 text-body-lg">
              {item.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
