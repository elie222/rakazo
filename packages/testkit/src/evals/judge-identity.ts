/** What a saved report records about the judge that can change its verdicts. */
export type RecordedJudge = {
  provider?: string;
  model: string;
  rubricVersion: string;
  /** Missing in reports from before they were recorded. */
  settings?: JudgeSettings;
};

export type JudgeSettings = {
  endpoint: string | null;
  maxOutputTokens: number | null;
  reasoning: boolean | null;
  thinkingLevel: string | null;
};

const SETTINGS: ReadonlyArray<keyof JudgeSettings> = [
  "endpoint",
  "maxOutputTokens",
  "reasoning",
  "thinkingLevel",
];

/**
 * How two judges differ, as `judge` when only one exists or `judge.<field>` otherwise. When
 * either never recorded its settings, they are unknown and named `judge.settings`.
 */
export function judgeDifferences(a: RecordedJudge | null, b: RecordedJudge | null): string[] {
  if (!a || !b) return a === b ? [] : ["judge"];
  const differences = (["provider", "model", "rubricVersion"] as const).filter(
    (key) => (a[key] ?? "") !== (b[key] ?? ""),
  );
  const [before, after] = [a.settings, b.settings];
  const settings =
    before && after
      ? SETTINGS.filter((key) => before[key] !== after[key])
      : (["settings"] as const);
  return [...differences, ...settings].map((key) => `judge.${key}`);
}
