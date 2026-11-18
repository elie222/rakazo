export function desktopGuardRefusalMessage(reason: string, suggestScript: boolean): string {
  const recovery = suggestScript
    ? " Write the steps to a script file and run it with python3 or bash; this is not a permission or credential error."
    : "";
  return `This command was not run: desktop-protection guard: ${reason}. Shell access is still available.${recovery} Do not stop or restart browser or desktop processes.`;
}
