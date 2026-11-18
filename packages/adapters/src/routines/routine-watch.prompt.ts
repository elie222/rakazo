/** Starts the note a change trigger appends to a routine's prompt; what follows is not the owner's. */
export const ROUTINE_WATCH_NOTE_START =
  "\n\nThis run was started because something you watch changed (";

export function routineWatchNote(watched: string, detail: string | null): string {
  return `${ROUTINE_WATCH_NOTE_START}${watched}).\nWhat changed since the last check:\n${detail ?? "(no detail)"}`;
}
