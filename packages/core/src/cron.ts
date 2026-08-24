import { Cron } from "croner";

const WEEKDAYS = "1-5";

export const CRON_FREQS = [
  "Every hour",
  "Every day",
  "Weekdays",
  "Every week",
  "Every month",
  "Interval",
  "Advanced",
] as const;

export type CronFreq = (typeof CRON_FREQS)[number];
export type CronUnit = "minutes" | "hours" | "days";

export type CronPreset = {
  freq: CronFreq;
  n: number;
  unit: CronUnit;
  time: string;
  cron: string;
};

export type CronPresetInput = {
  freq: CronFreq;
  n?: number;
  unit?: CronUnit;
  time?: string;
  cron?: string;
};

export function defaultCronPreset(): CronPreset {
  return { freq: "Every day", n: 3, unit: "minutes", time: "9:00 AM", cron: "" };
}

export function cronFromPreset(input: CronPresetInput): string {
  if (input.freq === "Advanced") return input.cron?.trim() || "*/3 * * * *";
  if (input.freq === "Every hour") return "0 * * * *";
  if (input.freq === "Interval") {
    const n = Number.isFinite(input.n) && (input.n ?? 0) > 0 ? (input.n as number) : 5;
    if (input.unit === "days") return `0 0 */${n} * *`;
    if (input.unit === "hours") return `0 */${n} * * *`;
    return `*/${n} * * * *`;
  }
  const { hour, minute } = parseClock(input.time ?? "9:00 AM");
  if (input.freq === "Weekdays") return `${minute} ${hour} * * ${WEEKDAYS}`;
  if (input.freq === "Every week") return `${minute} ${hour} * * 1`;
  if (input.freq === "Every month") return `${minute} ${hour} 1 * *`;
  return `${minute} ${hour} * * *`;
}

export function presetFromCron(cron: string): CronPreset {
  const base = defaultCronPreset();
  const trimmed = cron.trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length < 5) {
    return { ...base, freq: "Advanced", cron: trimmed };
  }
  const minute = parts[0] ?? "*";
  const hour = parts[1] ?? "*";
  const day = parts[2] ?? "*";
  const month = parts[3] ?? "*";
  const dow = parts[4] ?? "*";
  if (month !== "*") {
    return { ...base, freq: "Advanced", cron: trimmed };
  }

  const minuteStep = stepValue(minute);
  const hourStep = stepValue(hour);
  const dayStep = stepValue(day);

  if (minute === "0" && hour === "*" && day === "*" && dow === "*") {
    return { ...base, freq: "Every hour" };
  }
  if (minuteStep && hour === "*" && day === "*" && dow === "*") {
    return { ...base, freq: "Interval", n: minuteStep, unit: "minutes" };
  }
  if (minute === "0" && hourStep && day === "*" && dow === "*") {
    return { ...base, freq: "Interval", n: hourStep, unit: "hours" };
  }
  if (minute === "0" && hour === "0" && dayStep && dow === "*") {
    return { ...base, freq: "Interval", n: dayStep, unit: "days" };
  }
  if (!isInt(minute) || !isInt(hour)) {
    return { ...base, freq: "Advanced", cron: trimmed };
  }

  const time = formatClock(Number(hour), Number(minute));
  if (day === "*" && dow === WEEKDAYS) {
    return { ...base, freq: "Weekdays", time };
  }
  if (day === "*" && dow === "1") {
    return { ...base, freq: "Every week", time };
  }
  if (day === "1" && dow === "*") {
    return { ...base, freq: "Every month", time };
  }
  if (day === "*" && dow === "*") {
    return { ...base, freq: "Every day", time };
  }
  return { ...base, freq: "Advanced", cron: trimmed };
}

export function describeCronPreset(preset: CronPreset): { lead: string; detail: string } {
  if (preset.freq === "Interval") {
    return { lead: "Every", detail: `${preset.n} ${preset.unit}` };
  }
  if (preset.freq === "Every hour") {
    return { lead: "Every hour", detail: "" };
  }
  if (preset.freq === "Advanced") {
    return { lead: "Cron", detail: preset.cron || "*/3 * * * *" };
  }
  if (preset.freq === "Weekdays") {
    return { lead: "Weekdays", detail: `at ${preset.time}` };
  }
  if (preset.freq === "Every week") {
    return { lead: "Every Monday", detail: `at ${preset.time}` };
  }
  if (preset.freq === "Every month") {
    return { lead: "Monthly", detail: `on the 1st at ${preset.time}` };
  }
  return { lead: "Every day", detail: `at ${preset.time}` };
}

export function formatSchedule(preset: CronPreset): string {
  const { lead, detail } = describeCronPreset(preset);
  return [lead, detail].filter(Boolean).join(" ");
}

export function formatCron(cron: string): string {
  return formatSchedule(presetFromCron(cron));
}

export function nextCronDate(cron: string, from: Date, timezone = "UTC"): Date {
  if (cron.trim().split(/\s+/).length !== 5) {
    throw new RangeError("Cron expressions must contain five fields");
  }
  const schedule = new Cron(cron, {
    paused: true,
    timezone: validTimezoneOrUtc(timezone),
  });
  const next = schedule.nextRun(from);
  if (!next) throw new RangeError(`Cron expression has no future run: ${cron}`);
  return next;
}

function validTimezoneOrUtc(timezone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return timezone;
  } catch {
    return "UTC";
  }
}

function parseClock(time: string): { hour: number; minute: number } {
  const [rawH, rest] = time.split(":");
  const minute = Number((rest ?? "00").slice(0, 2));
  let hour = Number(rawH);
  if (/pm/i.test(time) && hour < 12) hour += 12;
  if (/am/i.test(time) && hour === 12) hour = 0;
  return { hour, minute };
}

function formatClock(hour: number, minute: number): string {
  const period = hour >= 12 ? "PM" : "AM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, "0")} ${period}`;
}

function stepValue(expr: string): number | null {
  const match = /^\*\/(\d+)$/.exec(expr);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isInt(expr: string): boolean {
  return /^\d+$/.test(expr);
}
