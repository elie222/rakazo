export function routineRunInstruction(name: string | undefined, alongsideChat: boolean): string {
  const run = `This is one scheduled run of your routine${name ? ` "${name}"` : ""}: do the work now, and do not schedule it again.`;
  if (!alongsideChat) return run;
  return `${run} It runs alongside the chat, so you see only the chat's latest messages and this routine's earlier results; search the chat's history when you need more. When an earlier result already reported something, say what changed rather than repeating it.`;
}
