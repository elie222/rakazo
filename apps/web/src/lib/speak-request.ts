/** The text to start, or nothing when a newer click already owns playback. */
export function spokenTextForRequest(
  request: number,
  current: number,
  spoken: { hostSpoken: boolean; text: string },
): string | null {
  if (request !== current || spoken.hostSpoken || !spoken.text) return null;
  return spoken.text;
}
