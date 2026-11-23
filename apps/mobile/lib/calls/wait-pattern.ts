export type WaitTone = "wood" | "hollow";
export type WaitUnit = { tone: WaitTone; pattern: number };

export const WAIT_PATTERNS = 10;

/** Pick a tone and pattern without repeating the last pattern; 0 means none played yet. */
export function nextWaitUnit(last: number, random: () => number = Math.random): WaitUnit {
  const tone: WaitTone = random() < 0.5 ? "wood" : "hollow";
  const excludes = last >= 1 && last <= WAIT_PATTERNS;
  let pattern = 1 + Math.floor(random() * (excludes ? WAIT_PATTERNS - 1 : WAIT_PATTERNS));
  if (excludes && pattern >= last) pattern += 1;
  return { tone, pattern };
}
