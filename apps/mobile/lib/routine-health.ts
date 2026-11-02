import type { RpcOutput } from "@rakazo/contracts";
import { activityStatusLabel } from "./activity";
import { t } from "./i18n";

export function routineHealthLines(health: RpcOutput<"routines/health">, locale: string): string[] {
  const date = (value: string) => new Date(value).toLocaleString(locale);
  return [
    health.nextRunAt
      ? t("Next scheduled: {date}", { date: date(health.nextRunAt) })
      : t("No upcoming schedule"),
    ...(health.delayed ? [t("Schedule delayed")] : []),
    ...(health.lastAttempt
      ? [
          t("Last attempt: {date} · {status}", {
            date: date(health.lastAttempt.at),
            status: activityStatusLabel(health.lastAttempt.status),
          }),
        ]
      : []),
    health.lastSuccessAt
      ? t("Last successful run: {date}", { date: date(health.lastSuccessAt) })
      : t("No successful runs yet"),
  ];
}
