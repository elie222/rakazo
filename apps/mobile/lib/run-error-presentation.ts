import type { RunErrorTranslator } from "@rakazo/core";

/** The label of the one action that fixes the failure; transient failures have none. */
export function runErrorActionLabel(
  t: RunErrorTranslator,
  error: { recovery?: "connection" | "model"; kind?: string },
) {
  if (error.recovery === "model") return t("Change model");
  if (error.recovery === "connection")
    return error.kind === "auth" ? t("Replace key") : t("Add Model");
  return null;
}

/** Only human-readable fields leave this boundary. Copy retains the original diagnostic. */
export function parseRunDiagnostic(raw: string, locale: string, now = Date.now()) {
  const prefix = /^\s*(\d{3})\s*:\s*/.exec(raw);
  const body = raw.slice(prefix?.[0].length ?? 0);
  let record: Record<string, unknown> = {};
  try {
    record = asRecord(JSON.parse(body));
  } catch {
    // Malformed provider envelopes are still readable without JSON punctuation.
  }
  const nested = asRecord(record.error);
  const payload = Object.keys(nested).length ? nested : record;
  const metadata = asRecord(payload.metadata ?? record.metadata);
  const message = readable(typeof payload.message === "string" ? payload.message : body);
  const status = Number(prefix?.[1] ?? record.status ?? record.code ?? payload.code);
  const limit = /\b(daily|weekly|monthly)\b/i
    .exec(String(payload.limit ?? metadata.limit ?? message))?.[1]
    ?.toLowerCase();
  const reset =
    payload.reset_at ??
    payload.reset ??
    metadata.reset_at ??
    metadata.reset ??
    message.match(/\bresets?\s+(\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?)/i)?.[1];
  let resets: string | undefined;
  if (typeof reset === "string" && /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?$/.test(reset)) {
    const date = new Date(reset);
    if (date.getTime() > now && date.toISOString().slice(0, 10) === reset.slice(0, 10)) {
      resets = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
        date,
      );
    }
  }
  return {
    status: Number.isInteger(status) && status >= 100 && status <= 599 ? String(status) : undefined,
    message,
    limit,
    resets,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function readable(value: string) {
  return value.replace(/[{}[\]"“”]/g, "").trim();
}

/** The shared classifier owns error meaning; recovery actions only open settings. */
export function runErrorWhatHappened(
  t: RunErrorTranslator,
  error: { kind?: string; period?: string },
) {
  if (error.kind === "key") {
    switch (error.period) {
      case "daily":
        return t(
          "This bot's reply stopped at its key's daily limit. Your own key has its own limits.",
        );
      case "weekly":
        return t(
          "This bot's reply stopped at its key's weekly limit. Your own key has its own limits.",
        );
      case "monthly":
        return t(
          "This bot's reply stopped at its key's monthly limit. Your own key has its own limits.",
        );
      default:
        return t(
          "This bot's reply stopped at its key's usage limit. Your own key has its own limits.",
        );
    }
  }
  if (error.kind === "credit" || error.kind === "spending") {
    switch (error.period) {
      case "daily":
        return t("The bot couldn't reply because its provider's daily limit was reached.");
      case "weekly":
        return t("The bot couldn't reply because its provider's weekly limit was reached.");
      case "monthly":
        return t("The bot couldn't reply because its provider's monthly limit was reached.");
      default:
        return t("The bot couldn't reply because its provider's usage limit was reached.");
    }
  }
  switch (error.kind) {
    case "rate":
      return t("The provider received too many requests to answer this bot.");
    case "auth":
      return t("The provider refused the key this bot used for its reply.");
    case "model":
      return t("The provider couldn't serve the model selected for this bot.");
    default:
      return t("The bot couldn't finish its reply. Technical details includes the reported error.");
  }
}
