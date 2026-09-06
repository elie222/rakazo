import type { RunActivityRow } from "@rakazo/contracts";
import { rpc } from "../lib/api";
import { dateLocaleForUi, t } from "./i18n";

export async function fetchSpaceActivity(): Promise<{
  active: RunActivityRow[];
  recent: RunActivityRow[];
}> {
  const [active, recent] = await Promise.all([
    rpc<{ runs: RunActivityRow[] }>("runs/list", { filter: "active" }),
    rpc<{ runs: RunActivityRow[] }>("runs/list", { filter: "recent" }),
  ]);
  return { active: active.runs, recent: recent.runs };
}

export function formatActivityRelativeTime(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (seconds < 45) return t("just now");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("{count}m ago", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("{count}h ago", { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return t("{count}d ago", { count: days });
  return date.toLocaleDateString(dateLocaleForUi(), { month: "short", day: "numeric" });
}

export function activityStatusLabel(status: RunActivityRow["status"]): string {
  switch (status) {
    case "queued":
      return t("Queued");
    case "leased":
      return t("Starting");
    case "running":
      return t("Running");
    case "waiting_input":
      return t("Needs input");
    case "waiting_takeover":
      return t("Needs takeover");
    case "completed":
      return t("Done");
    case "failed":
      return t("Failed");
    case "cancelled":
      return t("Cancelled");
    default:
      return status;
  }
}
