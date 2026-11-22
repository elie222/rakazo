export type ScheduleUnit = "minutes" | "hours" | "days" | "seconds";

/** The largest step the cron parser takes per unit: a step past the end of its field has no schedule. */
const INTERVAL_STEP_MAX: Partial<Record<ScheduleUnit, number>> = {
  minutes: 60,
  hours: 24,
  days: 31,
};

/** Why an interval has no schedule, with only the intervals that do, or null when it is in range. */
export function intervalRangeError(every: number, unit: ScheduleUnit): string | null {
  const max = INTERVAL_STEP_MAX[unit];
  if (!max || every <= max) return null;
  const head = `every ${every} ${unit} is out of range: ${unit} take 1 to ${max}.`;
  const cron =
    'For a longer schedule, such as monthly or yearly, use cron (for example "0 9 1 * *").';
  if (unit === "days") return `${head} ${cron}`;
  const larger =
    unit === "minutes" && every < 1440
      ? { name: "hours", size: 60 }
      : { name: "days", size: unit === "minutes" ? 1440 : 24 };
  const limit = INTERVAL_STEP_MAX[larger.name as ScheduleUnit] ?? 0;
  const exact = every / larger.size;
  if (Number.isInteger(exact)) {
    if (exact > limit) return `${head} ${cron}`;
    const noun = exact === 1 ? larger.name.slice(0, -1) : larger.name;
    return `${head} That is exactly ${exact} ${noun}: use every ${exact}, unit "${larger.name}".`;
  }
  const nearest = [Math.max(1, Math.floor(exact)), Math.ceil(exact)].filter((n) => n <= limit);
  if (nearest.length === 0) return `${head} ${cron}`;
  const options = nearest.map((n) => `every ${n} ${larger.name}`).join(" or ");
  return `${head} ${every} ${unit} is not a whole number of ${larger.name}, so nearest ${nearest.length > 1 ? "are" : "is"} ${options} (unit "${larger.name}"). Do not retry with the same value.`;
}
