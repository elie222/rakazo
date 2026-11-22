import { t } from "@lingui/core/macro";
import type { CronFreq } from "@rakazo/core";

/** A schedule frequency as the schedule menus name it. */
export function cronFreqLabel(freq: CronFreq): string {
  switch (freq) {
    case "Every hour":
      return t`Every hour`;
    case "Every day":
      return t`Every day`;
    case "Weekdays":
      return t`Weekdays`;
    // The day is fixed, so the label carries it.
    case "Every week":
      return t`Every Monday`;
    case "Every month":
      return t`Monthly on the 1st`;
    case "Interval":
      return t`Interval`;
    case "Advanced":
      return t`Advanced`;
    default:
      return freq;
  }
}
