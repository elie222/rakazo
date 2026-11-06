import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { Routine } from "@rakazo/contracts";
import type { CronLabels } from "@rakazo/core";
import { ENGLISH_CRON_LABELS, formatCron } from "@rakazo/core";
import { Button } from "@rakazo/ui-web";
import { Clock, Pause, Plus } from "lucide-react";
import { cronLabels } from "../lib/cron";

export function routineTriggerSummary(
  routine: Routine,
  labels: CronLabels = ENGLISH_CRON_LABELS,
): string {
  if (!routine.active) return t`Paused`;
  const parts: string[] = [];
  if (routine.webhookEnabled) parts.push(t`When a webhook fires`);
  if (routine.githubEnabled) parts.push(t`Git event`);
  if (routine.messageProvider === "slack") parts.push(t`Slack message`);
  else if (routine.messageProvider === "teams") parts.push(t`Teams message`);
  else if (routine.messageProvider) parts.push(t`Message event`);
  if (routine.emailSenders) parts.push(t({ message: "Email", context: "routine trigger" }));
  for (const cron of routine.crons) parts.push(formatCron(cron, labels));
  if (routine.watch) parts.push(t`When something changes`);
  return parts.length > 0 ? parts.join(", ") : t`No trigger`;
}

export function RoutineList({
  routines,
  runningRoutineId,
  onCreate,
  onEdit,
  onStop,
}: {
  routines: Routine[];
  runningRoutineId?: string;
  onCreate: () => void;
  onEdit: (routine: Routine) => void;
  onStop: () => void;
}) {
  const { t } = useLingui();
  return (
    <div>
      <div className="mb-2 flex justify-end">
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
      {routines.map((routine) => (
        <RoutineListRow
          key={routine.id}
          routine={routine}
          running={runningRoutineId === routine.id}
          onOpen={() => onEdit(routine)}
          onStop={onStop}
        />
      ))}
    </div>
  );
}

function RoutineListRow({
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
  const { i18n } = useLingui();
  const scheduleLabels = cronLabels(i18n.locale);
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
          <span className="block truncate text-body-lg font-medium text-foreground" dir="auto">
            {routine.name}
          </span>
          <span className="flex min-w-0 gap-2 text-body-sm text-muted-foreground/80">
            <span className="truncate">{routineTriggerSummary(routine, scheduleLabels)}</span>
            {routine.modelProvider && routine.modelId ? (
              <span className="truncate">{routine.modelId}</span>
            ) : null}
          </span>
        </span>
      </button>
      {running ? (
        <>
          <span className="shrink-0 text-body-sm text-warning">
            <Trans>Running</Trans>
          </span>
          <Button
            size="xs"
            onClick={onStop}
            className="shrink-0 bg-warning/15 text-warning hover:bg-warning/25"
          >
            <Trans>Stop</Trans>
          </Button>
        </>
      ) : null}
    </div>
  );
}
