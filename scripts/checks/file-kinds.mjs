export const isTestFile = (file) => /(?:\.(?:test|spec)\.[^/]+|(?:^|\/)test_[^/]+\.py)$/.test(file);

export const isEvalFile = (file) =>
  /^packages\/testkit\/src\/(?:evals\/|cli\/(?:evals|approval-eval)\.ts$)/.test(file);
