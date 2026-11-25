const pad = (value: number) => String(value).padStart(2, "0");

export function localDateOfDay(day: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, date ?? 1);
}

export function dayOfLocalDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function dayOfUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function formatCalendarDay(day: string, locale: string): string {
  return localDateOfDay(day).toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
