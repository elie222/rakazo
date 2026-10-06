/**
 * Message timestamp label: time only for today, otherwise prefixed with a short date
 * (and the year when it differs) so older messages are not mistaken for recent ones.
 */
export function formatMessageTime(
  createdAt: string | Date,
  locale: string,
  now: Date = new Date(),
): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "";
  const sameYear = date.getFullYear() === now.getFullYear();
  const sameDay =
    sameYear && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  if (sameDay) return date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  return date.toLocaleString(locale, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  });
}
