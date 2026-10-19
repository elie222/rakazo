import type { Routine } from "@rakazo/contracts";
import { formatCron } from "@rakazo/core";
import { t } from "./i18n";

export function routineStatusLine(routine: Routine): string {
  const triggers = [
    ...routine.crons.map(formatCron),
    ...(routine.webhookEnabled ? [t("Webhook")] : []),
    ...(routine.githubEnabled ? [t("Git event")] : []),
    ...(routine.messageProvider === "slack"
      ? [t("Slack message")]
      : routine.messageProvider === "teams"
        ? [t("Teams message")]
        : routine.messageProvider
          ? [t("Message event")]
          : []),
  ].join(", ");
  return [routine.active ? t("Active") : t("Paused"), triggers, routine.timezone]
    .filter(Boolean)
    .join(" · ");
}
