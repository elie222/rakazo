import { useLingui } from "@lingui/react/macro";
import type { MessageBlock } from "@rakazo/contracts";

type RoutineEventBlock = Extract<MessageBlock, { kind: "routine_event" }>;

/** The one-line chat row for a routine that was created, changed, switched on or off, or deleted. */
export function RoutineEventRow({ block }: { block: RoutineEventBlock }) {
  const { t } = useLingui();
  const name = block.name;
  const label = {
    created: t`Created routine "${name}"`,
    updated: t`Updated routine "${name}"`,
    enabled: t`Enabled routine "${name}"`,
    disabled: t`Disabled routine "${name}"`,
    deleted: t`Deleted routine "${name}"`,
  }[block.change];
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
