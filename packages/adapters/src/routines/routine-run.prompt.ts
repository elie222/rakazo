export function routineRunInstruction(name: string | undefined): string {
  return `This is one scheduled run of your routine${name ? ` "${name}"` : ""}: do the work now, and do not schedule it again.`;
}
