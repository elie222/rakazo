export function desktopGuardRefusalMessage(reason: string): string {
  return `This command was not run: desktop-protection guard: ${reason}. Shell access is still available. Do not stop or restart browser or desktop processes.`;
}
