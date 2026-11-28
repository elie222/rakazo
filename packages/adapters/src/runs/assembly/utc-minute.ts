export function utcMinuteStamp(date: Date): string {
  return date.toISOString().slice(0, 16).replace("T", " ");
}
