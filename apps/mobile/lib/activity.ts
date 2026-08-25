import type { RunActivityRow } from "@rakazo/contracts";
import { rpc } from "../lib/api";

export async function fetchWorkspaceActivity(): Promise<{
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
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function activityStatusLabel(status: RunActivityRow["status"]): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "leased":
      return "Starting";
    case "running":
      return "Running";
    case "waiting_input":
      return "Needs input";
    case "waiting_takeover":
      return "Needs takeover";
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return status;
  }
}
