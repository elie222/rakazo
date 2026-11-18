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

/** At the top of the editor, for another member's routine: saving hands it to the editor. */
export function RoutineTakeoverNote({ routine }: { routine: Routine | null }) {
  const { t } = useLingui();
  if (!routine?.runsAs || routine.runsAs.isViewer) return null;
  const name = routine.runsAs.name;
  return (
    <p
      role="status"
      data-testid="routine-takeover-note"
      className="mb-5 text-body text-warning"
      dir="auto"
    >
      {t`Runs as ${name}. Saving makes it run as you.`}
    </p>
  );
}
