import { t } from "@lingui/core/macro";
import type { computerHoursOut } from "@rakazo/contracts";
import type { normalizeRunError, RunErrorRecovery } from "@rakazo/core";

/** The label of the one action that fixes the failure; transient failures have none. */
export function runErrorActionLabel(error: { recovery?: RunErrorRecovery; kind?: string }) {
  if (error.recovery === "model") return t`Change model`;
  if (error.recovery === "connection") return error.kind === "auth" ? t`Replace key` : t`Add model`;
  return null;
}

/**
 * The technical details shown for a failure the shared classifier already parsed. Only
 * human-readable fields leave this boundary; Copy keeps the original diagnostic.
 */
export function runErrorDiagnostic(
  error: Pick<
    ReturnType<typeof normalizeRunError>,
    "details" | "status" | "providerMessage" | "period" | "resetAt"
  >,
  locale: string,
) {
  return {
    status: error.status === undefined ? undefined : String(error.status),
    message: readable(error.providerMessage ?? error.details),
    limit: error.period === "none" ? undefined : error.period,
    resets:
      error.resetAt === undefined
        ? undefined
        : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
            error.resetAt,
          ),
  };
}

function readable(value: string) {
  return value.replace(/[{}[\]"“”]/g, "").trim();
}

/** Why computers ran out of hours, and the billing action that gives them more. */
export function computerHoursOutCopy(reason: ReturnType<typeof computerHoursOut>) {
  switch (reason) {
    case "trial":
      return {
        summary: t`Your trial's computer hours are used up.`,
        action: t`Start plan now`,
      };
    case "cancelled_trial":
      return { summary: t`Cancelled trials have no computer hours.`, action: t`Renew plan` };
    default:
      return { summary: t`This month's computer hours are used up.`, action: t`Upgrade` };
  }
}

/** The shared classifier owns error meaning; recovery actions only open settings. */
export function runErrorWhatHappened(error: {
  kind?: string;
  period?: string;
  recovery?: RunErrorRecovery;
}) {
  // The summary already names the plan's hours as the cause.
  if (error.recovery === "plan") return null;
  if (error.kind === "key") {
    switch (error.period) {
      case "daily":
        return t`This bot's reply stopped at its key's daily limit. Your own key has its own limits.`;
      case "weekly":
        return t`This bot's reply stopped at its key's weekly limit. Your own key has its own limits.`;
      case "monthly":
        return t`This bot's reply stopped at its key's monthly limit. Your own key has its own limits.`;
      default:
        return t`This bot's reply stopped at its key's usage limit. Your own key has its own limits.`;
    }
  }
  if (error.kind === "credit" || error.kind === "spending") {
    switch (error.period) {
      case "daily":
        return t`The bot couldn't reply because its provider's daily limit was reached.`;
      case "weekly":
        return t`The bot couldn't reply because its provider's weekly limit was reached.`;
      case "monthly":
        return t`The bot couldn't reply because its provider's monthly limit was reached.`;
      default:
        return t`The bot couldn't reply because its provider's usage limit was reached.`;
    }
  }
  switch (error.kind) {
    case "rate":
      return t`The provider received too many requests to answer this bot.`;
    case "auth":
      return t`The provider refused the key this bot used for its reply.`;
    case "model":
      return t`The provider couldn't serve the model selected for this bot.`;
    default:
      return t`The bot couldn't finish its reply. Technical details includes the reported error.`;
  }
}
