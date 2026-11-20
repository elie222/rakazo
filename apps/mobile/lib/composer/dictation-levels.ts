/** Levels the dictation waveform keeps, newest last; the bar draws as many as fit. */
export const DICTATION_LEVEL_COUNT = 64;

export const QUIET_LEVELS: readonly number[] = Array<number>(DICTATION_LEVEL_COUNT).fill(0);

const NOISE_FLOOR_DB = -60;
const NOISE_FLOOR_AMPLITUDE = 10 ** (NOISE_FLOOR_DB / 20);

/** A metering read in dBFS as a bar height from 0 to 1, compressed so speech fills the bar. */
export function levelFromDecibels(decibels: number | undefined): number {
  if (decibels === undefined || !Number.isFinite(decibels) || decibels <= NOISE_FLOOR_DB) return 0;
  if (decibels >= 0) return 1;
  const amplitude = 10 ** (decibels / 20);
  return Math.sqrt((amplitude - NOISE_FLOOR_AMPLITUDE) / (1 - NOISE_FLOOR_AMPLITUDE));
}

/** The waveform after one more read: the oldest level drops off the front. */
export function withLevel(levels: readonly number[], decibels: number | undefined): number[] {
  return [...levels.slice(1), levelFromDecibels(decibels)];
}
