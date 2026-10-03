import { useLingui } from "@lingui/react/macro";
import type { TicketPriority } from "@rakazo/contracts";
import { useMemo } from "react";

/** Readable labels for ticket priorities, shared by cards, menus, and dialogs. */
export function useTicketPriorityLabels(): Record<TicketPriority, string> {
  const { t } = useLingui();
  return useMemo(
    () => ({
      low: t`Low`,
      normal: t`Normal`,
      high: t`High`,
      urgent: t`Urgent`,
    }),
    [t],
  );
}
