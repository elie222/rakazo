import type { CalendarOperation } from "@rakazo/contracts";
import { approvalEffectKey } from "@rakazo/core/node/approval-effect-key";

/** Same calendar, run and draft retain their identity across retries and equivalent ISO offsets. */
export function calendarWriteKey(runId: string, operation: CalendarOperation) {
  const canonicalInstant = (value: string) => new Date(value).toISOString();
  if (operation.action === "create_calendar_event") {
    const { calendar, event } = operation.input;
    const { timing } = event;
    return approvalEffectKey(runId, operation.action, {
      calendar,
      event: {
        ...event,
        timing: timing.allDay
          ? timing
          : {
              ...timing,
              start: canonicalInstant(timing.start),
              end: canonicalInstant(timing.end),
            },
      },
    });
  }
  if (operation.action === "create_reminder" && operation.input.due) {
    const { due } = operation.input;
    return approvalEffectKey(runId, operation.action, {
      ...operation.input,
      due: { ...due, at: canonicalInstant(due.at) },
    });
  }
  return approvalEffectKey(runId, operation.action, operation.input);
}
