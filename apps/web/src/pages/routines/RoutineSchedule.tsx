import { Trans, useLingui } from "@lingui/react/macro";
import type { CronFreq, CronPreset, CronUnit } from "@rakazo/core";
import {
  CRON_FREQS,
  clampIntervalAmount,
  cronFromPreset,
  cronIntervalAmounts,
  localizedClock,
  russianIntervalUnit,
} from "@rakazo/core";
import { cronUnitLabel } from "@rakazo/i18n/cron";
import { Button, Input, OptionSelect } from "@rakazo/ui-web";
import { Clock, X } from "lucide-react";
import { cronFreqLabel } from "../../lib/routines/cron";

const UNITS: CronUnit[] = ["minutes", "hours", "days"];
const TIMES = [
  "6:00 AM",
  "7:00 AM",
  "8:00 AM",
  "9:00 AM",
  "12:00 PM",
  "3:00 PM",
  "6:00 PM",
  "9:00 PM",
];

const TIMED: CronFreq[] = ["Every day", "Weekdays", "Every week", "Every month"];

function russianIntervalControlLead(): string {
  // The amount select stays visible for 1, so use a construction that keeps
  // the number in the sentence grammatical: “Раз в 1 час”, “Раз в 2 часа”.
  return "Раз в";
}

export function RoutineSchedule({
  value,
  onChange,
  onRemove,
}: {
  value: CronPreset;
  onChange: (next: CronPreset) => void;
  onRemove: () => void;
}) {
  const { i18n, t } = useLingui();
  const times = TIMES.includes(value.time) ? TIMES : [...TIMES, value.time];
  const numbers = cronIntervalAmounts(value.unit, value.n);

  function patch(partial: Partial<CronPreset>) {
    onChange({ ...value, ...partial });
  }

  const intervalAmountSelect = (
    <OptionSelect
      size="sm"
      className="w-fit"
      value={String(value.n)}
      aria-label={t`Interval amount`}
      options={numbers.map((n) => ({ value: String(n), label: String(n) }))}
      onValueChange={(n) => patch({ n: Number(n) })}
    />
  );

  const intervalUnitSelect = (
    <OptionSelect<CronUnit>
      size="sm"
      className="w-fit"
      value={value.unit}
      aria-label={t`Interval unit`}
      options={UNITS.map((unit) => ({
        value: unit,
        label: i18n.locale === "ru" ? russianIntervalUnit(value.n, unit) : cronUnitLabel(unit),
      }))}
      onValueChange={(unit) => patch({ unit, n: clampIntervalAmount(value.n, unit) })}
    />
  );

  const timeSelect = (
    <OptionSelect
      size="sm"
      className="w-fit"
      value={value.time}
      aria-label={t`Time of day`}
      options={times.map((time) => ({ value: time, label: localizedClock(time, i18n.locale) }))}
      onValueChange={(time) => patch({ time })}
    />
  );

  return (
    <div className="rounded-xl border border-border p-3">
      <div className="flex items-center gap-2.5 px-0.5">
        <Clock size={16} strokeWidth={1.6} className="text-muted-foreground" aria-hidden />
        <span className="flex-1 text-body-lg text-foreground">
          <Trans>On a schedule</Trans>
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t`Remove schedule`}
          onClick={onRemove}
          className="text-muted-foreground"
        >
          <X />
        </Button>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2 text-body text-muted-foreground">
        <OptionSelect<CronFreq>
          size="sm"
          className="w-fit"
          value={value.freq}
          aria-label={t`How often`}
          options={CRON_FREQS.map((freq) => ({ value: freq, label: cronFreqLabel(freq) }))}
          onValueChange={(freq) => {
            if (freq === "Advanced") {
              patch({ freq, cron: cronFromPreset(value) });
              return;
            }
            patch({ freq });
          }}
        />
        {value.freq === "Interval" ? (
          i18n.locale === "ru" ? (
            <>
              {russianIntervalControlLead()} {intervalAmountSelect} {intervalUnitSelect}
            </>
          ) : (
            <Trans>
              every {intervalAmountSelect} {intervalUnitSelect}
            </Trans>
          )
        ) : null}
        {TIMED.includes(value.freq) ? <Trans>at {timeSelect}</Trans> : null}
        {value.freq === "Advanced" ? (
          <Input
            value={value.cron}
            placeholder="*/3 * * * *"
            aria-label={t`Cron expression`}
            onChange={(event) => patch({ cron: event.target.value })}
            size="sm"
            className="min-w-[120px] flex-1 font-mono text-body-sm md:text-body-sm"
          />
        ) : null}
      </div>
    </div>
  );
}
