export type DemoTrigger = {
  freq: string;
  n: number;
  unit: string;
  time: string;
  cron: string;
};

type DemoTranslator = (source: string, values?: Record<string, string | number>) => string;

function interpolate(source: string, values?: Record<string, string | number>): string {
  if (!values) return source;
  return source.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : match,
  );
}

export function defaultTrigger(): DemoTrigger {
  return { freq: "Every day", n: 3, unit: "minutes", time: "9:00 AM", cron: "" };
}

export function parseWhen(when: string): DemoTrigger {
  const trigger = defaultTrigger();
  if (!when) {
    return trigger;
  }
  const interval = /every\s+(\d+)\s*(min(?:ute)?s?|h(?:our)?s?|days?)/i.exec(when);
  if (interval) {
    trigger.freq = "Interval";
    trigger.n = Number(interval[1]);
    const unit = interval[2] ?? "";
    trigger.unit = /^h/i.test(unit) ? "hours" : /^d/i.test(unit) ? "days" : "minutes";
    return trigger;
  }
  const cron = /^cron\s+(.+)$/i.exec(when.trim());
  if (cron) {
    trigger.freq = "Advanced";
    trigger.cron = cron[1]?.trim() ?? "";
    return trigger;
  }
  if (/hourly/i.test(when)) {
    trigger.freq = "Every hour";
    return trigger;
  }
  if (/weekday/i.test(when)) {
    trigger.freq = "Weekdays";
  } else if (/monday|week/i.test(when)) {
    trigger.freq = "Every week";
  } else if (/month/i.test(when)) {
    trigger.freq = "Every month";
  }
  const time = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(when);
  if (time) {
    trigger.time = `${time[1]}:${time[2] || "00"} ${time[3]?.toUpperCase()}`;
  }
  return trigger;
}

export function describeTrigger(trigger: DemoTrigger, text: DemoTranslator = interpolate) {
  if (trigger.freq === "Interval") {
    return {
      lead: text("Every"),
      detail: text("{n} {unit}", { n: trigger.n, unit: text(trigger.unit) }),
    };
  }
  if (trigger.freq === "Every hour") {
    return { lead: text("Every hour"), detail: "" };
  }
  if (trigger.freq === "Advanced") {
    return { lead: text("Cron"), detail: trigger.cron || "*/3 * * * *" };
  }
  if (trigger.freq === "Weekdays") {
    return { lead: text("Weekdays"), detail: text("at {time}", { time: text(trigger.time) }) };
  }
  if (trigger.freq === "Every week") {
    return { lead: text("Every Monday"), detail: text("at {time}", { time: text(trigger.time) }) };
  }
  if (trigger.freq === "Every month") {
    return {
      lead: text("Monthly"),
      detail: text("on the 1st at {time}", { time: text(trigger.time) }),
    };
  }
  return { lead: text("Every day"), detail: text("at {time}", { time: text(trigger.time) }) };
}

export function whenLabel(triggers: DemoTrigger[]) {
  if (triggers.length === 0) {
    return "Unscheduled";
  }
  const { lead, detail } = describeTrigger(triggers[0] ?? defaultTrigger());
  return [lead, detail].filter(Boolean).join(" ");
}

/**
 * Keep custom seeded schedules (e.g. "Tue + Thu") when the editor triggers still
 * match parseWhen(sourceWhen). ProductDemo clears sourceWhen on any trigger edit
 * so an explicit daily 9:00 AM choice is not overwritten by the stale seed.
 */
export function resolveRoutineWhen(triggers: DemoTrigger[], sourceWhen?: string): string {
  if (
    sourceWhen &&
    JSON.stringify(triggers) === JSON.stringify([parseWhen(sourceWhen)])
  ) {
    return sourceWhen;
  }
  return whenLabel(triggers);
}

/**
 * List-label for a stored `when`: prefer a direct catalog hit (opaque seeds).
 * Only reparse through describeTrigger when the string round-trips via
 * whenLabel(parseWhen(...)) — i.e. it was produced by whenLabel. Opaque
 * customs and cron text stay as stored so English (and other locales without
 * a direct hit) do not collapse them to daily 9:00 AM.
 */
export function displayRoutineWhen(when: string, text: DemoTranslator): string {
  const direct = text(when);
  if (direct !== when) return direct;
  const parsed = parseWhen(when);
  if (whenLabel([parsed]) !== when) return when;
  const { lead, detail } = describeTrigger(parsed, text);
  return [lead, detail].filter(Boolean).join(" ");
}
