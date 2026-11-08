import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { CronFreq, CronPreset, CronUnit } from "@rakazo/core";
import {
  CRON_FREQS,
  clampIntervalAmount,
  cronFromPreset,
  cronIntervalAmounts,
  describeCronPreset,
  localizedClock,
  russianIntervalUnit,
} from "@rakazo/core";
import { Input } from "@rakazo/ui-web";
import { Clock } from "lucide-react";
import { AppSelect } from "../components/AppSelect";
import { cronLabels, cronUnitLabel } from "../lib/cron";

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

function cronFreqLabel(freq: CronFreq): string {
  switch (freq) {
    case "Every hour":
      return t`Every hour`;
    case "Every day":
      return t`Every day`;
    case "Weekdays":
      return t`Weekdays`;
    case "Every week":
      return t`Every week`;
    case "Every month":
      return t`Every month`;
    case "Interval":
      return t`Interval`;
    case "Advanced":
      return t`Advanced`;
    default:
      return freq;
  }
}

function russianIntervalControlLead(): string {
  // The amount select stays visible for 1, so use a construction that keeps
  // the number in the sentence grammatical: “Раз в 1 час”, “Раз в 2 часа”.
  return "Раз в";
}

export function RoutineSchedule({
  value,
  onChange,
}: {
  value: CronPreset;
  onChange: (next: CronPreset) => void;
}) {
  const { i18n, t } = useLingui();
  const { lead, detail } = describeCronPreset(value, cronLabels(i18n.locale));
  const times = TIMES.includes(value.time) ? TIMES : [...TIMES, value.time];
  const numbers = cronIntervalAmounts(value.unit, value.n);

  function patch(partial: Partial<CronPreset>) {
    onChange({ ...value, ...partial });
  }

  const intervalAmountSelect = (
    <AppSelect
      size="sm"
      value={String(value.n)}
      aria-label={t`Interval amount`}
      options={numbers.map((n) => ({ value: String(n), label: String(n) }))}
      onValueChange={(next) => patch({ n: Number(next) })}
    />
  );

  const intervalUnitSelect = (
    <AppSelect
      size="sm"
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
    <AppSelect
      size="sm"
      value={value.time}
      aria-label={t`Time of day`}
      options={times.map((time) => ({
        value: time,
        label: localizedClock(time, i18n.locale),
      }))}
      onValueChange={(time) => patch({ time })}
    />
  );

  return (
    <div className="mt-2 rounded-xl border border-border p-3">
      <div className="flex items-center gap-2.5 px-0.5">
        <Clock size={17} strokeWidth={1.6} className="shrink-0 text-muted-foreground" aria-hidden />
        <span className="text-body-lg text-foreground">{lead}</span>
        {detail ? (
          <span className="flex-1 text-body-lg text-muted-foreground">{detail}</span>
        ) : null}
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2 text-body text-muted-foreground">
        <AppSelect
          size="sm"
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
            className="h-7 min-w-[120px] flex-1 font-mono text-body-sm md:text-body-sm"
          />
        ) : null}
      </div>
    </div>
  );
}
