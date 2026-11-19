import { useLingui } from "@lingui/react/macro";
import type { Routine } from "@rakazo/contracts";

/** "Runs as Dana", only for another member's routine: whose accounts and approval rules its runs use. */
export function RunsAsLabel({ routine }: { routine: Routine }) {
  const { t } = useLingui();
  if (!routine.runsAs || routine.runsAs.isViewer) return null;
  const name = routine.runsAs.name;
  return (
    <span data-testid="routine-runs-as" className="truncate" dir="auto">
      {t`Runs as ${name}`}
    </span>
  );
}

/** At the top of the editor, for another member's routine: why its fields cannot be changed. */
export function RoutineOwnerNote({ routine }: { routine: Routine | null }) {
  const { t } = useLingui();
  if (!routine?.runsAs || routine.runsAs.isViewer) return null;
  const name = routine.runsAs.name;
  return (
    <p data-testid="routine-owner-note" className="mb-5 text-body text-muted-foreground" dir="auto">
      {t`Runs as ${name}. Only they can change it.`}
    </p>
  );
}
