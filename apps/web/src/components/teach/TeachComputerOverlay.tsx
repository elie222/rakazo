import { Trans, useLingui } from "@lingui/react/macro";
import type { ComputerStatus } from "@rakazo/contracts";
import { Button, Label, Popover, PopoverContent, PopoverTrigger, Textarea } from "@rakazo/ui-web";
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
  const recoveryVisible = !goalOpen && needsRefresh && recoveryOpen;

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

  function closeGoal() {
    setGoalOpen(false);
    setError(null);
  }

  return (
    <Popover
      open={goalOpen || recoveryVisible}
      onOpenChange={(open) => {
        if (!open) {
          if (goalOpen) closeGoal();
          else setRecoveryOpen(false);
          return;
        }
        if (syncingRecording) return;
        if (needsRefresh) {
          // Keep Start recording locked; only reopen refresh recovery.
          setRecoveryOpen(true);
          return;
        }
        setError(null);
        setGoalOpen(true);
      }}
    >
      <PopoverTrigger
        data-testid="teach-start-button"
        aria-label={t`Teach a task`}
        disabled={busy || syncingRecording}
        render={<Button variant="outline" size="sm" />}
      >
        <span
          aria-hidden
          className="inline-block h-2 w-2 shrink-0 rounded-full border border-foreground"
        />
        <Trans>Teach a task</Trans>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        data-testid={goalOpen ? "teach-chrome-popover" : "teach-refresh-recovery"}
        className="w-[min(360px,calc(100vw-2rem))]"
      >
        {goalOpen ? (
          <>
            <Label
              htmlFor="teach-goal-input"
              className="text-[13px] font-normal text-muted-foreground"
            >
              <Trans>What result will you demonstrate?</Trans>
            </Label>
            <Textarea
              id="teach-goal-input"
              data-testid="teach-goal-input"
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              rows={3}
              placeholder={t`Export this week's list from the CRM and drop it in the shared folder`}
            />
            {error ? (
              <div role="alert" className="text-[13px] text-destructive">
                {error}
              </div>
            ) : null}
            <div className="flex gap-2">
              <Button
                disabled={busy || startLocked || !goal.trim()}
                onClick={() => void startTeaching()}
              >
                {busy || syncingRecording ? (
                  <Trans>Starting…</Trans>
                ) : (
                  <Trans>Start recording</Trans>
                )}
              </Button>
              <Button variant="outline" onClick={closeGoal}>
                <Trans>Cancel</Trans>
              </Button>
            </div>
          </>
        ) : (
          <>
            {error ? (
              <div role="alert" className="text-[13px] text-destructive">
                {error}
              </div>
            ) : (
              <p className="text-[13px] text-muted-foreground">
                <Trans>Recording started. Refresh the view to continue.</Trans>
              </p>
            )}
            <div className="flex gap-2">
              <Button disabled={busy} onClick={() => void refreshView()}>
                {busy ? <Trans>Refreshing…</Trans> : <Trans>Refresh view</Trans>}
              </Button>
              <Button variant="outline" onClick={() => setRecoveryOpen(false)}>
                <Trans>Dismiss</Trans>
              </Button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
