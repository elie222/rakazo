import type { RunActivityRow } from "@rakazo/contracts";
import { formatRelativeTime } from "@rakazo/i18n/activity";
import { rpc } from "../api/api";
import { dateLocaleForUi } from "../i18n/i18n";

export async function fetchSpaceActivity(): Promise<{
  active: RunActivityRow[];
  recent: RunActivityRow[];
}> {
  const [active, recent] = await Promise.all([
    rpc("runs/list", { filter: "active" }),
    rpc("runs/list", { filter: "recent" }),
  ]);
  return { active: active.runs, recent: recent.runs };
}

/** Relative time in the app's date locale. */
export function formatActivityRelativeTime(iso: string, now = new Date()): string {
  return formatRelativeTime(iso, dateLocaleForUi(), now);
}
