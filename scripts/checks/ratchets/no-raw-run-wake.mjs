export const message =
  "Do not enqueue runContinueJob(...) directly. Call wakeRun(jobs, runId) from @rakazo/adapters; it applies the one error policy for nudging a run: a failed nudge is logged and never fails the work that recorded the run.";

export const include = ["{apps,packages}/**/*.{ts,tsx,mts}"];

export const exclude = [
  "**/*.{test,spec}.*",
  "packages/adapter-kit/src/background-jobs.ts",
  "packages/adapters/src/runs/wakeups/wake-run.ts",
];

export const pattern = /\brunContinueJob\(/g;
