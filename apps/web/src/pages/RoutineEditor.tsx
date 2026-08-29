import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { Routine } from "@rakazo/contracts";
import {
  type CronFreq,
  type CronPreset,
  cronFromPreset,
  defaultCronPreset,
  formatCron,
  isOneShotRoutineCrons,
  presetFromCron,
} from "@rakazo/core";
import { ChevronLeft, ChevronRight, Pause, Plus, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { RoutineSchedule } from "./RoutineSchedule";

function toDatetimeLocalValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function defaultArmRunAtLocal(): string {
  return toDatetimeLocalValue(new Date(Date.now() + 60 * 60 * 1000));
}

export function routineNeedsOneShotArm(
  routine: Pick<Routine, "nextRunAt" | "lastRunAt">,
  crons: string[],
) {
  return isOneShotRoutineCrons(crons) && !routine.nextRunAt && !routine.lastRunAt;
}

const SCHEDULE_PRESETS: CronFreq[] = [
  "Every hour",
  "Every day",
  "Weekdays",
  "Every week",
  "Every month",
  "Interval",
  "Advanced",
];

const COMING_SOON = [
  { id: "slack", label: () => t`Slack message` },
  { id: "git", label: () => t`Git event` },
  { id: "teams", label: () => t`Teams message` },
  { id: "linear", label: () => t`Linear issue` },
  { id: "sentry", label: () => t`Sentry alert` },
  { id: "pagerduty", label: () => t`PagerDuty incident` },
] as const;

export type RoutineDraftState = {
  name: string;
  prompt: string;
  schedules: CronPreset[];
  webhookEnabled: boolean;
  active: boolean;
  runAtLocal: string;
};

export function emptyRoutineDraft(): RoutineDraftState {
  return {
    name: "",
    prompt: "",
    schedules: [],
    webhookEnabled: false,
    active: true,
    runAtLocal: "",
  };
}

export function draftFromRoutine(routine: Routine): RoutineDraftState {
  return {
    name: routine.name,
    prompt: routine.prompt,
    schedules: routine.crons.map(presetFromCron),
    webhookEnabled: routine.webhookEnabled,
    active: routine.active,
    runAtLocal: routineNeedsOneShotArm(routine, routine.crons) ? defaultArmRunAtLocal() : "",
  };
}

export function routineTriggerSummary(routine: Routine): string {
  if (!routine.active) return t`Paused`;
  const parts: string[] = [];
  if (routine.webhookEnabled) parts.push(t`When a webhook fires`);
  for (const cron of routine.crons) parts.push(formatCron(cron));
  return parts.length > 0 ? parts.join(" · ") : t`No trigger`;
}

export function RoutineListHeader({ onCreate }: { onCreate: () => void }) {
  const { t } = useLingui();
  return (
    <div className="mt-[30px] mb-3 flex items-center justify-between gap-3">
      <div className="text-[14px] text-[#85858A]">
        <Trans>Routines</Trans>
      </div>
      <button
        type="button"
        aria-label={t`New routine`}
        onClick={onCreate}
        className="grid h-8 w-8 place-items-center rounded-[10px] border border-[#3B82F6] bg-[#2563EB] text-white"
      >
        <Plus size={16} strokeWidth={2.2} />
      </button>
    </div>
  );
}

export function RoutineListRow({
  routine,
  running,
  onOpen,
  onStop,
}: {
  routine: Routine;
  running: boolean;
  onOpen: () => void;
  onStop: () => void;
}) {
  return (
    <div className="flex w-full items-center gap-2 rounded-[11px] px-2.5 py-2.5 hover:bg-[#121214]">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 text-start"
      >
        <span className="grid h-5 w-5 place-items-center">
          {routine.active ? (
            <span className="text-[#4ADE80]">
              <ClockIcon />
            </span>
          ) : (
            <Pause size={14} className="text-[#85858A]" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14.5px] font-medium text-[#ECECEE]" dir="auto">
            {routine.name}
          </span>
          <span className="block truncate text-[12.5px] text-[#6C6C70]">
            {routineTriggerSummary(routine)}
          </span>
        </span>
      </button>
      {running ? (
        <button
          type="button"
          onClick={onStop}
          className="shrink-0 rounded-full bg-[rgba(230,87,7,.14)] px-2.5 py-1 text-[12px] text-[#E65707]"
        >
          <Trans>Running · Stop</Trans>
        </button>
      ) : null}
    </div>
  );
}

export function RoutineEditor({
  draft,
  onChange,
  editing,
  timezone,
  webhook,
  saving,
  running,
  error,
  onBack,
  onClose,
  onSave,
  onTestRun,
  onDelete,
  onEnsureWebhook,
}: {
  draft: RoutineDraftState;
  onChange: (next: RoutineDraftState) => void;
  editing: Routine | null;
  timezone: string;
  webhook: { path: string; secret: string | null; configured: boolean };
  saving: boolean;
  running: boolean;
  error: string | null;
  onBack: () => void;
  onClose: () => void;
  onSave: () => void;
  onTestRun: () => void;
  onDelete: () => void;
  onEnsureWebhook: () => Promise<void>;
}) {
  const { t } = useLingui();
  const [menuOpen, setMenuOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const addTriggerId = useId();
  const hasTriggers = draft.schedules.length > 0 || draft.webhookEnabled;
  const canTest = Boolean(editing) && !saving && !running;
  const needsOneShotArm =
    editing != null && routineNeedsOneShotArm(editing, draft.schedules.map(cronFromPreset));

  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
        setScheduleOpen(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMenuOpen(false);
        setScheduleOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  function addSchedule(freq: CronFreq) {
    const base = defaultCronPreset();
    const next: CronPreset =
      freq === "Advanced" ? { ...base, freq, cron: cronFromPreset(base) } : { ...base, freq };
    onChange({ ...draft, schedules: [...draft.schedules, next] });
    setMenuOpen(false);
    setScheduleOpen(false);
  }

  async function addWebhook() {
    onChange({ ...draft, webhookEnabled: true });
    setMenuOpen(false);
    setScheduleOpen(false);
    if (!webhook.configured) {
      await onEnsureWebhook().catch(() => undefined);
    }
  }

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <button type="button" onClick={onBack} className="text-[#9A9AA0]" aria-label={t`Back`}>
          <ChevronLeft size={18} strokeWidth={1.8} />
        </button>
        <div className="text-[15.5px] font-medium text-[#F1F1F2]">
          <Trans>Routine</Trans>
        </div>
        <button type="button" onClick={onClose} className="text-[#6C6C70]" aria-label={t`Close`}>
          <X size={16} strokeWidth={1.8} />
        </button>
      </div>

      <div className="mb-5 flex items-center justify-between gap-3">
        <label className="flex items-center gap-2.5 text-[14px] text-[#C9C9CE]">
          <button
            type="button"
            role="switch"
            aria-checked={draft.active}
            onClick={() => onChange({ ...draft, active: !draft.active })}
            className={`relative h-[22px] w-[40px] rounded-full transition-colors ${
              draft.active ? "bg-[#3B82F6]" : "bg-[#2A2A2E]"
            }`}
          >
            <span
              className={`absolute top-[2px] h-[18px] w-[18px] rounded-full bg-white transition-transform ${
                draft.active ? "translate-x-[20px]" : "translate-x-[2px]"
              }`}
            />
          </button>
          <Trans>Active</Trans>
        </label>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={saving || running}
            onClick={onDelete}
            className="rounded-[11px] bg-[#1A1A1D] px-3.5 py-2 text-[13.5px] text-[#ECECEE] disabled:opacity-40"
          >
            <Trans>Delete</Trans>
          </button>
          <button
            type="button"
            disabled={!canTest}
            onClick={onTestRun}
            className="rounded-[11px] bg-[#1A1A1D] px-3.5 py-2 text-[13.5px] text-[#ECECEE] disabled:opacity-40"
          >
            {running ? t`Running…` : t`Test run`}
          </button>
        </div>
      </div>

      <label className="text-[14px] text-[#85858A]">
        <Trans>Name</Trans>
        <input
          value={draft.name}
          placeholder={t`Name this routine`}
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
          className="mt-2 w-full rounded-[11px] border border-[#26262A] bg-transparent px-3.5 py-3 text-[#ECECEE] placeholder:text-[#5C5C62]"
        />
      </label>

      <label className="mt-5 block text-[14px] text-[#85858A]">
        <Trans>Instruction</Trans>
        <textarea
          value={draft.prompt}
          placeholder={t`What should this routine do each time it runs?`}
          onChange={(e) => onChange({ ...draft, prompt: e.target.value })}
          rows={4}
          className="mt-2 w-full rounded-[11px] border border-[#26262A] bg-transparent px-3.5 py-3 text-[#ECECEE] placeholder:text-[#5C5C62]"
        />
      </label>

      <div className="mt-5 text-[14px] text-[#85858A]">
        <div className="flex items-baseline gap-2">
          <Trans>When to run</Trans>
          <span className="text-[12.5px] text-[#6E6E74]">{timezone}</span>
        </div>

        <div className="mt-2 space-y-2">
          {draft.schedules.map((preset, index) => (
            <div key={index} className="relative">
              <RoutineSchedule
                value={preset}
                onChange={(next) =>
                  onChange({
                    ...draft,
                    schedules: draft.schedules.map((item, i) => (i === index ? next : item)),
                  })
                }
              />
              <button
                type="button"
                aria-label={t`Remove schedule`}
                onClick={() =>
                  onChange({
                    ...draft,
                    schedules: draft.schedules.filter((_, i) => i !== index),
                  })
                }
                className="absolute top-3 right-3 text-[#85858A] hover:text-[#ECECEE]"
              >
                <X size={14} strokeWidth={1.8} />
              </button>
            </div>
          ))}

          {draft.webhookEnabled ? (
            <WebhookTriggerCard
              saved={Boolean(editing)}
              path={webhook.path}
              secret={webhook.secret}
              configured={webhook.configured}
              onRemove={() => onChange({ ...draft, webhookEnabled: false })}
              onRotate={() => void onEnsureWebhook()}
            />
          ) : null}

          {needsOneShotArm ? (
            <label className="block text-[14px] text-[#85858A]">
              <Trans>Run at</Trans>
              <input
                type="datetime-local"
                value={draft.runAtLocal}
                onChange={(e) => onChange({ ...draft, runAtLocal: e.target.value })}
                aria-label={t`Run at`}
                className="mt-2 w-full rounded-[11px] border border-[#26262A] bg-transparent px-3.5 py-3 text-[#ECECEE]"
              />
            </label>
          ) : null}
        </div>

        <div className="relative mt-2" ref={menuRef}>
          <button
            type="button"
            id={addTriggerId}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => {
              setMenuOpen((open) => !open);
              setScheduleOpen(false);
            }}
            className="flex w-full items-center justify-center gap-2 rounded-[13px] border border-[#26262A] px-3.5 py-3 text-[14.5px] text-[#ECECEE] hover:bg-[#121214]"
          >
            <Plus size={16} strokeWidth={1.8} />
            <Trans>Add trigger</Trans>
          </button>

          {menuOpen ? (
            <div
              role="menu"
              aria-labelledby={addTriggerId}
              className="absolute right-0 bottom-full z-20 mb-2 min-w-[220px] rounded-[14px] border border-[#2A2A2E] bg-[#16161A] py-1.5 shadow-[0_12px_40px_rgba(0,0,0,.55)]"
            >
              <div className="relative">
                <button
                  type="button"
                  role="menuitem"
                  onMouseEnter={() => setScheduleOpen(true)}
                  onFocus={() => setScheduleOpen(true)}
                  onClick={() => setScheduleOpen((open) => !open)}
                  className="flex w-full items-center justify-between gap-3 px-3.5 py-2.5 text-start text-[14px] text-[#ECECEE] hover:bg-[#1E1E22]"
                >
                  <span className="flex items-center gap-2.5">
                    <ClockIcon />
                    <Trans>On a schedule</Trans>
                  </span>
                  <ChevronRight size={14} className="text-[#85858A]" />
                </button>
                {scheduleOpen ? (
                  <div
                    role="menu"
                    className="absolute top-0 right-full mr-1.5 min-w-[170px] overflow-hidden rounded-[14px] border border-[#2A2A2E] bg-[#16161A] py-1.5 shadow-[0_12px_40px_rgba(0,0,0,.55)]"
                  >
                    {SCHEDULE_PRESETS.map((freq) => (
                      <button
                        key={freq}
                        type="button"
                        role="menuitem"
                        onClick={() => addSchedule(freq)}
                        className="flex w-full items-center justify-between gap-3 px-3.5 py-2.5 text-start text-[14px] text-[#ECECEE] hover:bg-[#1E1E22]"
                      >
                        {schedulePresetLabel(freq)}
                        {freq === "Every day" || freq === "Weekdays" ? (
                          <ChevronRight size={14} className="text-[#85858A]" />
                        ) : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>

              {COMING_SOON.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  disabled
                  title={t`Coming soon`}
                  className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-start text-[14px] text-[#6C6C70]"
                >
                  <span
                    aria-hidden
                    className="inline-block h-3.5 w-3.5 rounded-[4px]"
                    style={{ background: comingSoonColor(item.id), opacity: 0.55 }}
                  />
                  {item.label()}
                </button>
              ))}

              <button
                type="button"
                role="menuitem"
                disabled={draft.webhookEnabled}
                onClick={() => void addWebhook()}
                className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-start text-[14px] text-[#ECECEE] hover:bg-[#1E1E22] disabled:text-[#6C6C70]"
              >
                <GlobeIcon />
                <Trans>Webhook</Trans>
              </button>
            </div>
          ) : null}
        </div>

        {!hasTriggers ? (
          <p className="mt-2 text-[12.5px] text-[#6E6E74]">
            <Trans>Add a schedule or webhook to run this routine.</Trans>
          </p>
        ) : null}
      </div>

      <div className="mt-5">
        <button
          type="button"
          disabled={saving || running || !hasTriggers}
          onClick={onSave}
          className="rounded-[11px] bg-[#F1F1EF] px-4 py-2 text-[#17171A] disabled:opacity-40"
        >
          {saving ? t`Saving…` : t`Save`}
        </button>
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-[13px] text-[#EF6461]">
          {error}
        </p>
      ) : null}

      <div className="mt-8 text-[14px] text-[#85858A]">
        <Trans>Run history</Trans>
        <p className="mt-2 text-[13.5px] text-[#6C6C70]">
          <Trans>No runs yet</Trans>
        </p>
      </div>
    </div>
  );
}

function WebhookTriggerCard({
  saved,
  path,
  secret,
  configured,
  onRemove,
  onRotate,
}: {
  saved: boolean;
  path: string;
  secret: string | null;
  configured: boolean;
  onRemove: () => void;
  onRotate: () => void;
}) {
  const { t } = useLingui();
  const pending = !saved;
  const placeholder = t`Available after the routine is saved`;
  const postValue = pending ? placeholder : path;
  const keyValue = pending
    ? placeholder
    : (secret ?? (configured ? t`Saved. Rotate to reveal.` : placeholder));
  const headerValue = pending
    ? placeholder
    : secret
      ? `Authorization: Bearer ${secret}`
      : configured
        ? "Authorization: Bearer …"
        : placeholder;

  return (
    <div className="rounded-[13px] border border-[#26262A] p-3">
      <div className="flex items-center gap-2.5 px-0.5">
        <GlobeIcon />
        <span className="flex-1 text-[14.5px] text-[#ECECEE]">
          <Trans>When a webhook fires</Trans>
        </span>
        <button
          type="button"
          aria-label={t`Remove webhook`}
          onClick={onRemove}
          className="text-[#85858A] hover:text-[#ECECEE]"
        >
          <X size={14} strokeWidth={1.8} />
        </button>
      </div>
      <div className="mt-2.5 space-y-2.5 rounded-[11px] bg-[#16161A] px-2.5 py-2.5 text-[13.5px]">
        <div className="block text-[#7A7A80]">
          <Trans>POST to</Trans>
          <div className="mt-1 break-all rounded-lg bg-[#24242A] px-2.5 py-1.5 font-mono text-[12.5px] text-[#C9C9CE]">
            {postValue}
          </div>
        </div>
        <div className="flex items-center gap-2 text-[#7A7A80]">
          <span className="shrink-0">
            <Trans>key</Trans>
          </span>
          <div className="min-w-0 flex-1 break-all rounded-lg bg-[#24242A] px-2.5 py-1.5 font-mono text-[12.5px] text-[#C9C9CE]">
            {keyValue}
          </div>
        </div>
        <div className="block text-[#7A7A80]">
          <Trans>header</Trans>
          <div className="mt-1 break-all rounded-lg bg-[#24242A] px-2.5 py-1.5 font-mono text-[12.5px] text-[#C9C9CE]">
            {headerValue}
          </div>
        </div>
        {saved && configured && !secret ? (
          <button
            type="button"
            onClick={onRotate}
            className="text-[12.5px] text-[#9A9AA0] hover:text-[#ECECEE]"
          >
            <Trans>Rotate key</Trans>
          </button>
        ) : null}
      </div>
    </div>
  );
}

function schedulePresetLabel(freq: CronFreq): string {
  switch (freq) {
    case "Every hour":
      return t`Every hour`;
    case "Every day":
      return t`Every day`;
    case "Weekdays":
      return t`Weekdays`;
    case "Every week":
      return t`Every week`;
    case "Every month":
      return t`Every month`;
    case "Interval":
      return t`Interval`;
    case "Advanced":
      return t`Advanced...`;
    default:
      return freq;
  }
}

function comingSoonColor(id: string): string {
  switch (id) {
    case "slack":
      return "#E01E5A";
    case "git":
      return "#8B949E";
    case "teams":
      return "#6264A7";
    case "linear":
      return "#5E6AD2";
    case "sentry":
      return "#A467FD";
    default:
      return "#06AC38";
  }
}

function ClockIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </svg>
  );
}
