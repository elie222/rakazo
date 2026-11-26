import { Trans, useLingui } from "@lingui/react/macro";
import type { ByokInterval, HeldCreditAmount, MODEL_CREDIT_AMOUNTS } from "@rakazo/contracts";
import {
  ByokIntervalSchema,
  byokYearlySavingsPercent,
  creditAmountChoices,
  HeldCreditAmountSchema,
} from "@rakazo/contracts";
import { formatBillingAmount, formatMonthlyPrice } from "@rakazo/i18n/billing";
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
