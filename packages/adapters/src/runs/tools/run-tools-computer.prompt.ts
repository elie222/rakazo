/** Added to a shell command that failed for want of a display. */
export function shellNoDisplayNotice(screenTool: string): string {
  return `This bot's computer has a screen that is not open yet. Call ${screenTool} to open it, then run the command again without setting DISPLAY.`;
}
