import { Trans, useLingui } from "@lingui/react/macro";
import type { ComputerStatus, TaughtSkill } from "@rakazo/contracts";
import { useMemo, useState } from "react";
import { rpc } from "../../lib/rpc";
import { TeachRecordingChrome } from "./TeachRecordingChrome";

export function TeachComputerSection({
  botId,
  computer,
  skills,
  busy: busyProp,
  onRefresh,
  onOpenComputer,
  onStopTeaching,
  onAddRoutine,
}: {
  botId: string;
  computer: ComputerStatus | null;
  skills: TaughtSkill[];
  busy?: boolean;
  onRefresh: () => Promise<void>;
  onOpenComputer: () => Promise<void>;
  onStopTeaching?: () => Promise<void>;
  onAddRoutine: (skill: TaughtSkill) => void;
}) {
  const { t } = useLingui();
  const [goalOpen, setGoalOpen] = useState(false);
  const [goal, setGoal] = useState("");
  const [localBusy, setLocalBusy] = useState(false);
  const busy = Boolean(busyProp) || localBusy;
  const recording = useMemo(
    () => skills.find((skill) => skill.status === "recording") ?? null,
    [skills],
  );
  const saved = useMemo(
    () => skills.filter((skill) => skill.status === "saved" || skill.status === "draft"),
    [skills],
  );
  const teachAvailable = Boolean(computer && computer.kind !== "desktop");

  async function startTeaching() {
    if (!goal.trim() || busy) return;
    setLocalBusy(true);
    try {
      await rpc.computer.boot({ botId });
      await rpc.skills.start({ botId, goal: goal.trim() });
      setGoalOpen(false);
      setGoal("");
      await onOpenComputer();
      await onRefresh();
    } finally {
      setLocalBusy(false);
    }
  }

  async function stopTeaching() {
    if (!recording || busy) return;
    if (onStopTeaching) {
      await onStopTeaching();
      return;
    }
    setLocalBusy(true);
    try {
      await rpc.skills.stop({ skillId: recording.id });
      await onRefresh();
    } finally {
      setLocalBusy(false);
    }
  }

  return (
    <div className="mt-[30px]">
      <div className="mb-3 text-[14px] text-[#85858A]">
        <Trans>Teach a task</Trans>
      </div>
      {!teachAvailable ? (
        <div className="rounded-[11px] border border-[#232326] px-3 py-3 text-[13.5px] leading-[1.5] text-[#6C6C70]">
          {computer?.kind === "desktop" ? (
            <Trans>
              Teaching needs a graphical sandbox computer. Desktop-host bots can run shell tasks,
              but not screen recording.
            </Trans>
          ) : (
            <Trans>Open the computer view on web or desktop to teach a task.</Trans>
          )}
        </div>
      ) : recording ? (
        <TeachRecordingChrome
          recording={recording}
          busy={busy}
          onStop={stopTeaching}
          variant="panel"
        />
      ) : goalOpen ? (
        <div className="rounded-[11px] border border-[#232326] bg-[#121214] px-3 py-3">
          <label htmlFor="teach-goal-input" className="text-[13px] text-[#85858A]">
            <Trans>What result will you demonstrate?</Trans>
          </label>
          <textarea
            id="teach-goal-input"
            data-testid="teach-goal-input"
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            rows={3}
            className="mt-2 w-full rounded-[10px] border border-[#26262A] bg-[#0E0E10] px-3 py-2 text-[14px] text-[#ECECEE] outline-none"
            placeholder={t`Export this week's list from the CRM and drop it in the shared folder`}
          />
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={busy || !goal.trim()}
              onClick={() => void startTeaching()}
              className="rounded-[11px] bg-[#F1F1EF] px-4 py-2 text-[14px] text-[#17171A] disabled:opacity-40"
            >
              {busy ? <Trans>Starting…</Trans> : <Trans>Start recording</Trans>}
            </button>
            <button
              type="button"
              onClick={() => setGoalOpen(false)}
              className="rounded-[11px] border border-[#26262A] px-4 py-2 text-[14px] text-[#ECECEE]"
            >
              <Trans>Cancel</Trans>
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          data-testid="teach-start-button"
          onClick={() => setGoalOpen(true)}
          className="flex items-center gap-2.5 px-2.5 py-2.5 text-[14.5px] text-[#7A7A80]"
        >
          <Trans>+ Teach a task</Trans>
        </button>
      )}

      {saved.length > 0 ? (
        <>
          <div className="mt-[22px] mb-3 text-[14px] text-[#85858A]">
            <Trans>Saved skills</Trans>
          </div>
          {saved.map((skill) => (
            <div key={skill.id} className="mb-2 rounded-[11px] border border-[#232326] px-3 py-3">
              <div className="text-[14px] text-[#ECECEE]">{skill.name || skill.goal}</div>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    setLocalBusy(true);
                    try {
                      await rpc.skills.testRun({ skillId: skill.id });
                      await onRefresh();
                    } finally {
                      setLocalBusy(false);
                    }
                  }}
                  className="rounded-[11px] border border-[#26262A] px-3 py-1.5 text-[13px] text-[#ECECEE]"
                >
                  <Trans>Test</Trans>
                </button>
                <button
                  type="button"
                  onClick={() => onAddRoutine(skill)}
                  className="rounded-[11px] border border-[#26262A] px-3 py-1.5 text-[13px] text-[#ECECEE]"
                >
                  <Trans>Add to routine</Trans>
                </button>
                <button
                  type="button"
                  disabled={busy || skill.status !== "draft"}
                  onClick={async () => {
                    setLocalBusy(true);
                    try {
                      await rpc.skills.save({ skillId: skill.id });
                      await onRefresh();
                    } finally {
                      setLocalBusy(false);
                    }
                  }}
                  className="rounded-[11px] bg-[#F1F1EF] px-3 py-1.5 text-[13px] text-[#17171A] disabled:opacity-40"
                >
                  <Trans>Save</Trans>
                </button>
              </div>
            </div>
          ))}
        </>
      ) : null}
    </div>
  );
}
