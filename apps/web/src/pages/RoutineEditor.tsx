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
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Input,
  Textarea,
} from "@rakazo/ui-web";
import { ChevronLeft, Clock, Globe, Pause, Plus, X } from "lucide-react";
import { useId } from "react";
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
      <div className="text-sm text-muted-foreground">
        <Trans>Routines</Trans>
      </div>
      <Button
        variant="secondary"
        size="icon-sm"
        data-testid="routine-create-button"
        aria-label={t`Create Routine`}
        title={t`Create Routine`}
        onClick={onCreate}
      >
        <Plus strokeWidth={1.9} />
      </Button>
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
    <div className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2.5 hover:bg-accent">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 text-start"
      >
        <span className="grid h-5 w-5 place-items-center">
          {routine.active ? (
            <Clock size={16} strokeWidth={1.6} className="text-success" aria-hidden />
          ) : (
            <Pause size={14} className="text-muted-foreground" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14.5px] font-medium text-foreground" dir="auto">
            {routine.name}
          </span>
          <span className="block truncate text-[12.5px] text-muted-foreground/80">
            {routineTriggerSummary(routine)}
          </span>
        </span>
      </button>
      {running ? (
        <Button
          size="xs"
          onClick={onStop}
          className="shrink-0 rounded-full bg-warning/15 text-warning hover:bg-warning/25"
        >
          <Trans>Running · Stop</Trans>
        </Button>
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
  const fieldId = useId();
  const hasTriggers = draft.schedules.length > 0 || draft.webhookEnabled;
  const canTest = Boolean(editing) && !saving && !running;
  const needsOneShotArm =
    editing != null && routineNeedsOneShotArm(editing, draft.schedules.map(cronFromPreset));

  function addSchedule(freq: CronFreq) {
    const base = defaultCronPreset();
    const next: CronPreset =
      freq === "Advanced" ? { ...base, freq, cron: cronFromPreset(base) } : { ...base, freq };
    onChange({ ...draft, schedules: [...draft.schedules, next] });
  }

  async function addWebhook() {
    onChange({ ...draft, webhookEnabled: true });
    if (!webhook.configured) {
      await onEnsureWebhook().catch(() => undefined);
    }
  }

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onBack}
          className="text-muted-foreground"
          aria-label={t`Back`}
        >
          <ChevronLeft />
        </Button>
        <div className="text-[15.5px] font-medium text-foreground">
          <Trans>Routine</Trans>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          className="text-muted-foreground"
          aria-label={t`Close`}
        >
          <X />
        </Button>
      </div>

      <div className="mb-5 flex items-center justify-between gap-3">
        <label className="flex items-center gap-2.5 text-sm text-foreground/75">
          <button
            type="button"
            role="switch"
            aria-checked={draft.active}
            onClick={() => onChange({ ...draft, active: !draft.active })}
            className={`relative h-[22px] w-[40px] rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
              draft.active ? "bg-primary" : "bg-input"
            }`}
          >
            <span
              className={`absolute top-[2px] left-0 h-[18px] w-[18px] rounded-full bg-background transition-transform ${
                draft.active
                  ? "translate-x-[20px] dark:bg-primary-foreground"
                  : "translate-x-[2px] dark:bg-foreground"
              }`}
            />
          </button>
          <Trans>Active</Trans>
        </label>
        <div className="flex items-center gap-2">
          <Button variant="secondary" disabled={saving || running} onClick={onDelete}>
            <Trans>Delete</Trans>
          </Button>
          <Button variant="secondary" disabled={!canTest} onClick={onTestRun}>
            {running ? t`Running…` : t`Test run`}
          </Button>
        </div>
      </div>

      <label htmlFor={`${fieldId}-name`} className="block text-sm text-muted-foreground">
        <Trans>Name</Trans>
        <Input
          id={`${fieldId}-name`}
          value={draft.name}
          placeholder={t`Name this routine`}
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
          className="mt-2"
        />
      </label>

      <label htmlFor={`${fieldId}-prompt`} className="mt-5 block text-sm text-muted-foreground">
        <Trans>Instruction</Trans>
        <Textarea
          id={`${fieldId}-prompt`}
          value={draft.prompt}
          placeholder={t`What should this routine do each time it runs?`}
          onChange={(e) => onChange({ ...draft, prompt: e.target.value })}
          rows={4}
          className="mt-2"
        />
      </label>

      <div className="mt-5 text-sm text-muted-foreground">
        <div className="flex items-baseline gap-2">
          <Trans>When to run</Trans>
          <span className="text-xs text-muted-foreground/70">{timezone}</span>
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
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t`Remove schedule`}
                onClick={() =>
                  onChange({
                    ...draft,
                    schedules: draft.schedules.filter((_, i) => i !== index),
                  })
                }
                className="absolute top-2 right-2 text-muted-foreground"
              >
                <X />
              </Button>
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
            <label htmlFor={`${fieldId}-run-at`} className="block text-sm text-muted-foreground">
              <Trans>Run at</Trans>
              <Input
                id={`${fieldId}-run-at`}
                type="datetime-local"
                value={draft.runAtLocal}
                onChange={(e) => onChange({ ...draft, runAtLocal: e.target.value })}
                aria-label={t`Run at`}
                className="mt-2"
              />
            </label>
          ) : null}
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="outline" className="mt-2 h-auto w-full rounded-xl py-3" />}
          >
            <Plus />
            <Trans>Add trigger</Trans>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top">
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Clock />
                <Trans>On a schedule</Trans>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-[170px]">
                {SCHEDULE_PRESETS.map((freq) => (
                  <DropdownMenuItem key={freq} onClick={() => addSchedule(freq)}>
                    {schedulePresetLabel(freq)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            {COMING_SOON.map((item) => (
              <DropdownMenuItem key={item.id} disabled title={t`Coming soon`}>
                <span
                  aria-hidden
                  className="inline-block size-3.5 rounded-[4px]"
                  style={{ background: comingSoonColor(item.id), opacity: 0.55 }}
                />
                {item.label()}
              </DropdownMenuItem>
            ))}

            <DropdownMenuItem disabled={draft.webhookEnabled} onClick={() => void addWebhook()}>
              <Globe />
              <Trans>Webhook</Trans>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {!hasTriggers ? (
          <p className="mt-2 text-xs text-muted-foreground/70">
            <Trans>Add a schedule or webhook to run this routine.</Trans>
          </p>
        ) : null}
      </div>

      <div className="mt-5">
        <Button disabled={saving || running || !hasTriggers} onClick={onSave}>
          {saving ? t`Saving…` : t`Save`}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}

      <div className="mt-8 text-sm text-muted-foreground">
        <Trans>Run history</Trans>
        <p className="mt-2 text-[13.5px] text-muted-foreground/80">
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
  const cellClass =
    "break-all rounded-lg bg-muted px-2.5 py-1.5 font-mono text-xs text-foreground/75";

  return (
    <div className="rounded-xl border border-border p-3">
      <div className="flex items-center gap-2.5 px-0.5">
        <Globe size={16} strokeWidth={1.6} className="text-muted-foreground" aria-hidden />
        <span className="flex-1 text-[14.5px] text-foreground">
          <Trans>When a webhook fires</Trans>
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t`Remove webhook`}
          onClick={onRemove}
          className="text-muted-foreground"
        >
          <X />
        </Button>
      </div>
      <div className="mt-2.5 space-y-2.5 text-[13.5px]">
        <div className="block text-muted-foreground/70">
          <Trans>POST to</Trans>
          <div className={`mt-1 ${cellClass}`}>{postValue}</div>
        </div>
        <div className="flex items-center gap-2 text-muted-foreground/70">
          <span className="shrink-0">
            <Trans>key</Trans>
          </span>
          <div className={`min-w-0 flex-1 ${cellClass}`}>{keyValue}</div>
        </div>
        <div className="block text-muted-foreground/70">
          <Trans>header</Trans>
          <div className={`mt-1 ${cellClass}`}>{headerValue}</div>
        </div>
        {saved && configured && !secret ? (
          <Button
            variant="link"
            size="xs"
            onClick={onRotate}
            className="px-0 text-muted-foreground"
          >
            <Trans>Rotate key</Trans>
          </Button>
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
