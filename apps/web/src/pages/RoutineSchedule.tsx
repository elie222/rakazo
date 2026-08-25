import {
  CRON_FREQS,
  type CronFreq,
  type CronPreset,
  type CronUnit,
  cronFromPreset,
  describeCronPreset,
} from "@rakazo/core";
import { resolveUiLanguage, uiCopy } from "../lib/ui-copy";

const UNITS: CronUnit[] = ["minutes", "hours", "days"];
const NUMBERS = [1, 2, 3, 5, 10, 15, 30, 45];
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

function frequencyLabel(freq: CronFreq) {
  if (resolveUiLanguage() !== "ko") return freq;
  const labels: Record<CronFreq, string> = {
    "Every hour": "매시간",
    "Every day": "매일",
    Weekdays: "평일",
    "Every week": "매주",
    "Every month": "매월",
    Interval: "일정 간격",
    Advanced: "직접 설정",
  };
  return labels[freq];
}

function unitLabel(unit: CronUnit) {
  if (resolveUiLanguage() !== "ko") return unit;
  return unit === "minutes" ? "분" : unit === "hours" ? "시간" : "일";
}

function timeLabel(time: string) {
  if (resolveUiLanguage() !== "ko") return time;
  const match = /^(\d{1,2}:\d{2}) (AM|PM)$/.exec(time);
  return match ? `${match[2] === "AM" ? "오전" : "오후"} ${match[1]}` : time;
}

function localizedDescription(value: CronPreset) {
  if (resolveUiLanguage() !== "ko") return describeCronPreset(value);
  if (value.freq === "Interval") {
    return { lead: "반복", detail: `${value.n}${unitLabel(value.unit)}마다` };
  }
  if (value.freq === "Advanced") {
    return { lead: "Cron", detail: value.cron || "*/3 * * * *" };
  }
  const lead =
    value.freq === "Every hour"
      ? "매시간"
      : value.freq === "Weekdays"
        ? "평일마다"
        : value.freq === "Every week"
          ? "매주 월요일"
          : value.freq === "Every month"
            ? "매월 1일"
            : "매일";
  return {
    lead,
    detail: value.freq === "Every hour" ? "" : `${timeLabel(value.time)}에`,
  };
}

export function RoutineSchedule({
  value,
  onChange,
}: {
  value: CronPreset;
  onChange: (next: CronPreset) => void;
}) {
  const { lead, detail } = localizedDescription(value);
  const times = TIMES.includes(value.time) ? TIMES : [...TIMES, value.time];
  const numbers = NUMBERS.includes(value.n) ? NUMBERS : [...NUMBERS, value.n].sort((a, b) => a - b);

  function patch(partial: Partial<CronPreset>) {
    onChange({ ...value, ...partial });
  }

  return (
    <div className="mt-2 rounded-[13px] border border-[#26262A] p-3">
      <div className="flex items-center gap-2.5 px-0.5">
        <svg
          width="17"
          height="17"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#C9C9CE"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="shrink-0"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
        <span className="text-[14.5px] text-[#ECECEE]">{lead}</span>
        {detail ? <span className="flex-1 text-[14.5px] text-[#85858A]">{detail}</span> : null}
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-[11px] bg-[#16161A] px-2.5 py-2.5 text-[14px] text-[#7A7A80]">
        <select
          className="rk-schedule-select"
          value={value.freq}
          aria-label={uiCopy("How often")}
          onChange={(event) => {
            const freq = event.target.value as CronFreq;
            if (freq === "Advanced") {
              patch({ freq, cron: cronFromPreset(value) });
              return;
            }
            patch({ freq });
          }}
        >
          {CRON_FREQS.map((freq) => (
            <option key={freq} value={freq}>
              {frequencyLabel(freq)}
            </option>
          ))}
        </select>
        {value.freq === "Interval" ? (
          <>
            <span>{resolveUiLanguage() === "ko" ? "마다" : "every"}</span>
            <select
              className="rk-schedule-select"
              value={String(value.n)}
              aria-label={uiCopy("Interval amount")}
              onChange={(event) => patch({ n: Number(event.target.value) })}
            >
              {numbers.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <select
              className="rk-schedule-select"
              value={value.unit}
              aria-label={uiCopy("Interval unit")}
              onChange={(event) => patch({ unit: event.target.value as CronUnit })}
            >
              {UNITS.map((unit) => (
                <option key={unit} value={unit}>
                  {unitLabel(unit)}
                </option>
              ))}
            </select>
          </>
        ) : null}
        {TIMED.includes(value.freq) ? (
          <>
            <span>{resolveUiLanguage() === "ko" ? "시간" : "at"}</span>
            <select
              className="rk-schedule-select"
              value={value.time}
              aria-label={uiCopy("Time of day")}
              onChange={(event) => patch({ time: event.target.value })}
            >
              {times.map((time) => (
                <option key={time} value={time}>
                  {timeLabel(time)}
                </option>
              ))}
            </select>
          </>
        ) : null}
        {value.freq === "Advanced" ? (
          <input
            value={value.cron}
            placeholder="*/3 * * * *"
            aria-label={uiCopy("Cron expression")}
            onChange={(event) => patch({ cron: event.target.value })}
            className="min-w-[120px] flex-1 rounded-lg border-0 bg-[#24242A] px-2.5 py-1.5 font-mono text-[13.5px] text-[#ECECEE] outline-none"
          />
        ) : null}
      </div>
    </div>
  );
}
