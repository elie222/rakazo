import { useLingui } from "@lingui/react/macro";
import type { Routine } from "@rakazo/contracts";

/** The owner's name, only on another member's routine: its runs use their accounts and approval rules. */
export function OwnerLabel({ routine }: { routine: Routine }) {
  if (!routine.runsAs || routine.runsAs.isViewer) return null;
  return (
    <span data-testid="routine-owner" className="truncate" dir="auto">
      {routine.runsAs.name}
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
      {t`Only ${name} can change this routine.`}
    </p>
  );
}
