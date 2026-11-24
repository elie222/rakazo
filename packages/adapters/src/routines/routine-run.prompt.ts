export function routineRunInstruction(
  name: string | undefined,
  alongsideChat: boolean,
  lastRun = false,
): string {
  const scheduled = `This is one scheduled run of your routine${name ? ` "${name}"` : ""}: do the work now, and do not schedule it again. If only the user can unblock you, ask for the specific action you need. Use ask_user if available.`;
  const run = lastRun
    ? `${scheduled} It is the last run: the routine reaches its end date and is deleted after it, so say that it has ended when you report.`
    : scheduled;
  if (!alongsideChat) return run;
  return `${run} It runs alongside the chat, so you see only the chat's latest messages and this routine's earlier results; search the chat's history when you need more. When an earlier result already reported something, say what changed rather than repeating it.`;
}
