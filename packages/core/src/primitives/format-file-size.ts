const FILE_SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export type FileSizeUnit = (typeof FILE_SIZE_UNITS)[number];

function sizeParts(
  bytes: number,
  locale?: string,
  useGrouping?: boolean,
): { amount: string; unit: FileSizeUnit } | null {
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  let value = bytes;
  let unit = 0;
  while (unit < FILE_SIZE_UNITS.length - 1 && value >= 1024) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return { amount: String(Math.round(value)), unit: "B" };
  let rounded = Math.round(value * 10) / 10;
  if (rounded >= 1024 && unit < FILE_SIZE_UNITS.length - 1) {
    rounded = Math.round((rounded / 1024) * 10) / 10;
    unit += 1;
  }
  const amount = locale
    ? new Intl.NumberFormat(locale, { maximumFractionDigits: 1, useGrouping }).format(rounded)
    : Number.isInteger(rounded)
      ? String(rounded)
      : rounded.toFixed(1);
  return { amount, unit: FILE_SIZE_UNITS[unit] ?? "TB" };
}

/** The amount and unit of a file size; pass `locale` to localise the decimal separator. */
export function fileSizeParts(bytes: number, locale?: string) {
  return sizeParts(bytes, locale);
}

/** A compact label, with locale-aware decimals but no grouping separators. */
export function formatFileSize(bytes: number, locale?: string): string {
  const parts = sizeParts(bytes, locale, false);
  return parts ? `${parts.amount} ${parts.unit}` : "";
}
