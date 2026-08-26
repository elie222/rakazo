import { i18n } from "@lingui/core";
import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { RunActivityRow } from "@rakazo/contracts";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";

function statusColor(status: RunActivityRow["status"]): string {
  if (status === "failed") return "#FF5364";
  if (status === "cancelled") return "#85858A";
  if (status === "completed") return "#4ECB71";
  if (status === "waiting_input" || status === "waiting_takeover") return "#F5A03C";
  return "#8B5CF6";
}

type ActivityListProps = {
  onOpenRun: (run: RunActivityRow) => void;
};

export function ActivityList({ onOpenRun }: ActivityListProps) {
  const [activeRuns, setActiveRuns] = useState<RunActivityRow[]>([]);
  const [recentRuns, setRecentRuns] = useState<RunActivityRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const tick = async () => {
      try {
        const [active, recent] = await Promise.all([
          rpc.runs.list({ filter: "active" }),
          rpc.runs.list({ filter: "recent" }),
        ]);
        if (cancelled) return;
        setActiveRuns(active.runs);
        setRecentRuns(recent.runs);
      } catch {
        // Keep the last good snapshot on transient RPC failures.
        if (cancelled) return;
      } finally {
        if (!cancelled) {
          setLoading(false);
          // Schedule the next poll after the previous settles — no overlap.
          timer = window.setTimeout(() => void tick(), 15_000);
        }
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  if (loading) {
    return (
      <div className="px-2.5 py-2 text-[13px] text-[#6C6C70]">
        <Trans>Loading activity…</Trans>
      </div>
    );
  }

  if (activeRuns.length === 0 && recentRuns.length === 0) return null;

  return (
    <div className="mb-2 border-b border-[#202023] pb-2">
      {activeRuns.length > 0 ? (
        <section>
          <div className="px-2.5 pb-1 pt-1 text-[12.5px] font-medium text-[#6C6C70]">
            <Trans>Now</Trans>
          </div>
          {activeRuns.map((run) => (
            <ActivityRow key={run.runId} run={run} onOpen={() => onOpenRun(run)} />
          ))}
        </section>
      ) : null}
      {recentRuns.length > 0 ? (
        <section className={activeRuns.length > 0 ? "mt-2" : undefined}>
          <div className="px-2.5 pb-1 pt-1 text-[12.5px] font-medium text-[#6C6C70]">
            <Trans>Recent</Trans>
          </div>
          {recentRuns.map((run) => (
            <ActivityRow key={run.runId} run={run} onOpen={() => onOpenRun(run)} />
          ))}
        </section>
      ) : null}
    </div>
  );
}

function ActivityRow({ run, onOpen }: { run: RunActivityRow; onOpen: () => void }) {
  const { t } = useLingui();
  const title = run.groupName ? `${run.botName} · ${run.groupName}` : run.botName;
  const label = statusLabel(run.status);
  const activityLabel = t`${title}, ${label}`;
  return (
    <button
      type="button"
      aria-label={activityLabel}
      onClick={onOpen}
      className="flex w-full gap-3 rounded-xl px-2.5 py-[9px] text-left hover:bg-[#131315]"
    >
      <span
        className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: statusColor(run.status) }}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[14px] font-medium text-[#ECECEE]">{title}</span>
          <span className="shrink-0 text-[12px] text-[#6C6C70]">
            {formatRelativeTime(run.updatedAt)}
          </span>
        </div>
        <div className="mt-0.5 flex items-baseline gap-2">
          {run.promptSnippet ? (
            <span className="min-w-0 flex-1 truncate text-[13px] text-[#85858A]">
              {run.promptSnippet}
            </span>
          ) : null}
          <span className="ms-auto shrink-0 text-[12px]" style={{ color: statusColor(run.status) }}>
            {label}
          </span>
        </div>
      </div>
    </button>
  );
}

function formatRelativeTime(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (seconds < 45) return t`just now`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t`${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t`${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return t`${days}d ago`;
  return date.toLocaleDateString(i18n.locale || "en", { month: "short", day: "numeric" });
}

function statusLabel(status: RunActivityRow["status"]): string {
  switch (status) {
    case "queued":
      return t`Queued`;
    case "leased":
      return t`Starting`;
    case "running":
      return t`Running`;
    case "waiting_input":
      return t`Needs input`;
    case "waiting_takeover":
      return t`Needs takeover`;
    case "completed":
      return t`Done`;
    case "failed":
      return t`Failed`;
    case "cancelled":
      return t`Cancelled`;
    default:
      return status;
  }
}
