export interface NumericSummary {
  count: number;
  min: number;
  median: number;
  p95: number;
  max: number;
}

export interface PerformanceReport {
  schemaVersion: number;
  label: string;
  createdAt: string;
  environment: {
    gitSha: string;
    gitDirty: boolean;
    platform: string;
    release: string;
    arch: string;
    cpuModel: string;
    cpuCount: number;
    totalMemoryBytes: number;
    node: string;
    electron?: string;
    chrome?: string;
    playwright: string;
    buildMode: string;
    rendererMode: string;
    warmWindow: string;
    assetDelayMs?: number;
  };
  fixture: {
    backend: string;
    messageCount: number;
    webOrigin: string;
    launchSamples: number;
    cacheColdDefinition: string;
    warmDefinition: string;
  };
  launches: { cacheCold: unknown[]; warm: unknown[] };
  interactions: unknown;
  bundles: {
    web: BundleSize;
    desktop: BundleSize | null;
  };
  summary: {
    cacheColdShellUsableMs: NumericSummary;
    warmShellUsableMs: NumericSummary;
    settingsPaintedMs: number;
    settingsSettledMs: number;
    typingKeyPaintMs: NumericSummary;
    idleCpuPercent: NumericSummary;
    idleSummedPrivateKiB: NumericSummary;
    streamingCpuPercent: NumericSummary;
    reopenMs: number | null;
    hiddenSummedPrivateKiB: number | null;
  };
}

export interface BundleSize {
  fileCount: number;
  rawBytes: number;
  gzipBytes: number;
  brotliBytes: number;
}

export function summarize(values: number[]): NumericSummary {
  if (values.length === 0) throw new Error("Cannot summarize an empty sample");
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    min: sorted[0]!,
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1)!,
  };
}

export function percentageDelta(before: number, after: number) {
  if (before === 0) return after === 0 ? 0 : null;
  return ((after - before) / before) * 100;
}

export function roundMetric(value: number, digits = 2) {
  return Number(value.toFixed(digits));
}

function percentile(sorted: number[], quantile: number) {
  if (sorted.length === 1) return sorted[0]!;
  const index = (sorted.length - 1) * quantile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}
