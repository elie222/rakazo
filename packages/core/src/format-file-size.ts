const FILE_SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  let value = bytes;
  let unit = 0;
  while (unit < FILE_SIZE_UNITS.length - 1 && value >= 1024) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${Math.round(value)} B`;
  let rounded = Math.round(value * 10) / 10;
  if (rounded >= 1024 && unit < FILE_SIZE_UNITS.length - 1) {
    rounded = Math.round((rounded / 1024) * 10) / 10;
    unit += 1;
  }
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text} ${FILE_SIZE_UNITS[unit]}`;
}
