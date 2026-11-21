import { useLingui } from "@lingui/react/macro";
import type { MessageBlock, RoutineEventChange } from "@rakazo/contracts";

type RoutineEventBlock = Extract<MessageBlock, { kind: "routine_event" }>;

/** The chat's words for a routine that was created, changed, switched on or off, or deleted; the chat row and the exported transcript share them. */
export function useRoutineEventLabel(): (change: RoutineEventChange, name: string) => string {
  const { t } = useLingui();
  return (change, name) =>
    ({
      created: t`Created routine "${name}"`,
      updated: t`Updated routine "${name}"`,
      enabled: t`Enabled routine "${name}"`,
      disabled: t`Disabled routine "${name}"`,
      deleted: t`Deleted routine "${name}"`,
    })[change];
}

/** The one-line chat row for a routine event. */
export function RoutineEventRow({ block }: { block: RoutineEventBlock }) {
  const label = useRoutineEventLabel()(block.change, block.name);
  return (
    <div
      data-testid="routine-event-row"
      data-change={block.change}
      className="flex items-center justify-center py-0.5 text-body text-muted-foreground"
    >
      <span dir="auto" className="min-w-0 break-words text-center">
        {label}
      </span>
    </div>
  );
}
