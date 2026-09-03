import { Trans, useLingui } from "@lingui/react/macro";
import type { ComputerStatus } from "@rakazo/contracts";
import { useEffect, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";

/**
 * Compact Teach a task control for the computer chrome bar above the screen
 * (not painted on the framebuffer, and not in the agent sidepanel).
 *
 * Mount with key={botId} from Shell so a bot switch remounts clean state.
 * Async completions still check botIdRef so a late response from bot A cannot
 * mutate bot B if the instance is reused.
 */
export function TeachComputerOverlayControl({
  botId,
  computer,
  busy: busyProp,
  onRefresh,
}: {
  botId: string;
  computer: ComputerStatus | null;
  busy?: boolean;
  onRefresh: () => Promise<void>;
}) {
  const { t } = useLingui();
  const [goalOpen, setGoalOpen] = useState(false);
  const [goal, setGoal] = useState("");
  const [localBusy, setLocalBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const botIdRef = useRef(botId);
  botIdRef.current = botId;
  /**
   * Sticky once a recording is known active until Shell shows Stop teaching (this
   * control unmounts) or a probe for the current bot finds no recording. Dismiss
   * may hide recovery UI but must not clear this. Do not clear it just because
   * onRefresh resolved: Shell loads skills after threads.get returns.
   */
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  /** True while the mount probe runs so Start cannot race ahead of skills.list. */
  const [syncingRecording, setSyncingRecording] = useState(true);
  const busy = Boolean(busyProp) || localBusy;
  const startLocked = needsRefresh || syncingRecording;

  // Re-seed the lock from server state on mount / bot change. Local needsRefresh
  // is lost on remount and can leak across bots if not cleared when idle.
  // Lock immediately while the probe runs so a remount cannot start twice.
  useEffect(() => {
    let cancelled = false;
    const probeBotId = botId;
    setSyncingRecording(true);
    setGoalOpen(false);
    async function syncRecordingLock() {
      try {
        const skills = await rpc.skills.list({ botId: probeBotId });
        if (cancelled || botIdRef.current !== probeBotId) return;
        const recording = skills.some((skill) => skill.status === "recording");
        if (!recording) {
          setNeedsRefresh(false);
          setRecoveryOpen(false);
          setError(null);
          return;
        }
        setNeedsRefresh(true);
        setRecoveryOpen(true);
        try {
          await onRefresh();
          // Keep needsRefresh. Shell swaps to Stop teaching once skills land.
        } catch (refreshError) {
          if (cancelled || botIdRef.current !== probeBotId) return;
          setError(
            refreshError instanceof Error
              ? refreshError.message
              : t`Recording may have started, but the view could not refresh`,
          );
        }
      } catch {
        // Fail closed: a transient skills.list error must not unlock Start while
        // a recording may still be active.
        if (cancelled || botIdRef.current !== probeBotId) return;
        setNeedsRefresh(true);
        setRecoveryOpen(true);
        setError(t`Could not check teaching status. Refresh the view to continue.`);
      } finally {
        if (!cancelled && botIdRef.current === probeBotId) setSyncingRecording(false);
      }
    }
    void syncRecordingLock();
    return () => {
      cancelled = true;
    };
  }, [botId, onRefresh]); // t omitted: identity churn must not re-lock Start

  // Hide only for desktop-host bots. Null computer still shows the control so teaching can boot.
  if (computer?.kind === "desktop") return null;

  async function refreshView() {
    const requestBotId = botId;
    setLocalBusy(true);
    setError(null);
    try {
      await onRefresh();
      if (botIdRef.current !== requestBotId) return;
      // Confirm with skills.list. onRefresh can resolve before Shell applies skills.
      const skills = await rpc.skills.list({ botId: requestBotId });
      if (botIdRef.current !== requestBotId) return;
      if (skills.some((skill) => skill.status === "recording")) {
        setNeedsRefresh(true);
        // Keep recovery open until Shell mounts Stop teaching (this control
        // unmounts). Closing here leaves a Refresh loop if Shell's skills load failed.
        setRecoveryOpen(true);
        setGoal("");
        return;
      }
      setNeedsRefresh(false);
      setRecoveryOpen(false);
      setGoal("");
    } catch (refreshError) {
      if (botIdRef.current !== requestBotId) return;
      setNeedsRefresh(true);
      setRecoveryOpen(true);
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : t`Recording may have started, but the view could not refresh`,
      );
    } finally {
      if (botIdRef.current === requestBotId) setLocalBusy(false);
    }
  }

  async function startTeaching() {
    if (!goal.trim() || busy || startLocked) return;
    const requestBotId = botId;
    const requestGoal = goal.trim();
    setLocalBusy(true);
    setError(null);
    try {
      await rpc.computer.boot({ botId: requestBotId });
      await rpc.skills.start({ botId: requestBotId, goal: requestGoal });
      if (botIdRef.current !== requestBotId) return;
      // Recording has started. Keep Start locked; only refresh the view.
      setGoalOpen(false);
      setNeedsRefresh(true);
      try {
        await onRefresh();
        if (botIdRef.current !== requestBotId) return;
        setGoal("");
        // Keep needsRefresh + recovery until Shell unmounts this control when
        // recordingSkill lands. Closing recovery early hides Stop if skills lag.
        setRecoveryOpen(true);
      } catch (refreshError) {
        if (botIdRef.current !== requestBotId) return;
        setRecoveryOpen(true);
        setError(
          refreshError instanceof Error
            ? refreshError.message
            : t`Recording may have started, but the view could not refresh`,
        );
      }
    } catch (startError) {
      if (botIdRef.current !== requestBotId) return;
      const message =
        startError instanceof Error ? startError.message : t`Could not start teaching`;
      setError(message);
      // Server already has a session (e.g. remount before the probe finished).
      if (/already active/i.test(message)) {
        setNeedsRefresh(true);
        setRecoveryOpen(true);
        setGoalOpen(false);
      }
    } finally {
      if (botIdRef.current === requestBotId) setLocalBusy(false);
    }
  }

  return (
    <div className="relative flex max-w-[min(360px,100%)] flex-col items-end">
      {goalOpen ? (
        <div
          data-testid="teach-chrome-popover"
          className="absolute end-0 top-full z-20 mt-2 w-[min(360px,calc(100vw-2rem))] rounded-[12px] border border-[var(--rk-border)] bg-[var(--rk-inset)] px-3 py-3 shadow-[0_12px_40px_rgba(0,0,0,.45)]"
        >
          <label htmlFor="teach-goal-input" className="text-[13px] text-[var(--rk-muted)]">
            <Trans>What result will you demonstrate?</Trans>
          </label>
          <textarea
            id="teach-goal-input"
            data-testid="teach-goal-input"
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            rows={3}
            className="mt-2 w-full rounded-[10px] border border-[var(--rk-border)] bg-[var(--rk-panel)] px-3 py-2 text-[14px] text-[var(--rk-ink)] outline-none"
            placeholder={t`Export this week's list from the CRM and drop it in the shared folder`}
          />
          {error ? (
            <div role="alert" className="mt-2 text-[13px] text-[var(--rk-danger-soft)]">
              {error}
            </div>
          ) : null}
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={busy || startLocked || !goal.trim()}
              onClick={() => void startTeaching()}
              className="rounded-[11px] bg-[var(--rk-cream)] px-4 py-2 text-[14px] text-[var(--rk-cream-ink)] disabled:opacity-40"
            >
              {busy || syncingRecording ? <Trans>Starting…</Trans> : <Trans>Start recording</Trans>}
            </button>
            <button
              type="button"
              onClick={() => {
                setGoalOpen(false);
                setError(null);
              }}
              className="rounded-[11px] border border-[var(--rk-border)] px-4 py-2 text-[14px] text-[var(--rk-ink)]"
            >
              <Trans>Cancel</Trans>
            </button>
          </div>
        </div>
      ) : null}
      {!goalOpen && needsRefresh && recoveryOpen ? (
        <div
          data-testid="teach-refresh-recovery"
          className="absolute end-0 top-full z-20 mt-2 w-[min(320px,calc(100vw-2rem))] rounded-[12px] border border-[var(--rk-border)] bg-[var(--rk-inset)] px-3 py-3 shadow-[0_12px_40px_rgba(0,0,0,.45)]"
        >
          {error ? (
            <div role="alert" className="text-[13px] text-[var(--rk-danger-soft)]">
              {error}
            </div>
          ) : (
            <p className="text-[13px] text-[var(--rk-muted)]">
              <Trans>Recording started. Refresh the view to continue.</Trans>
            </p>
          )}
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void refreshView()}
              className="rounded-[11px] bg-[var(--rk-cream)] px-4 py-2 text-[14px] text-[var(--rk-cream-ink)] disabled:opacity-40"
            >
              {busy ? <Trans>Refreshing…</Trans> : <Trans>Refresh view</Trans>}
            </button>
            <button
              type="button"
              onClick={() => setRecoveryOpen(false)}
              className="rounded-[11px] border border-[var(--rk-border)] px-4 py-2 text-[14px] text-[var(--rk-ink)]"
            >
              <Trans>Dismiss</Trans>
            </button>
          </div>
        </div>
      ) : null}
      <button
        type="button"
        data-testid="teach-start-button"
        aria-label={t`Teach a task`}
        aria-expanded={goalOpen || (needsRefresh && recoveryOpen)}
        disabled={busy || syncingRecording}
        onClick={() => {
          if (syncingRecording) return;
          if (needsRefresh) {
            // Keep Start recording locked; only reopen refresh recovery.
            setRecoveryOpen((open) => !open);
            return;
          }
          setError(null);
          setGoalOpen((open) => !open);
        }}
        className="flex items-center gap-2 rounded-[10px] border border-[var(--rk-scroll)] bg-[var(--rk-surface)] px-3 py-1.5 text-[13px] text-[var(--rk-ink)] hover:bg-[var(--rk-surface-2)] disabled:opacity-40"
      >
        <span
          aria-hidden
          className="inline-block h-2 w-2 shrink-0 rounded-full border border-[var(--rk-ink)]"
        />
        <Trans>Teach a task</Trans>
      </button>
    </div>
  );
}
