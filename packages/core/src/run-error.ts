import { stuckWorkStatusMessages } from "./stuck-work.js";

export const MISSING_TOOL_FINAL_RESPONSE_ERROR =
  "The tools finished, but the model did not write a final answer. Rephrase the request and try again.";

const APP_RUN_ERRORS = new Set([MISSING_TOOL_FINAL_RESPONSE_ERROR, ...stuckWorkStatusMessages()]);

export const RUN_ERROR_LIMIT_MESSAGES = {
  key: {
    none: "{provider} key hit its limit.",
    daily: "{provider} key hit its daily limit.",
    weekly: "{provider} key hit its weekly limit.",
    monthly: "{provider} key hit its monthly limit.",
  },
  credit: {
    none: "{provider} reached its credit limit.",
    daily: "{provider} reached its daily credit limit.",
    weekly: "{provider} reached its weekly credit limit.",
    monthly: "{provider} reached its monthly credit limit.",
  },
  spending: {
    none: "{provider} reached its spending limit.",
    daily: "{provider} reached its daily spending limit.",
    weekly: "{provider} reached its weekly spending limit.",
    monthly: "{provider} reached its monthly spending limit.",
  },
} as const;

export type RunErrorTranslator = (
  message: string,
  values?: Record<string, string | number>,
) => string;

const english: RunErrorTranslator = (message, values) =>
  message.replace(/\{(\w+)\}/g, (match, key: string) => String(values?.[key] ?? match));

/** Keep provider diagnostics available without exposing them in the visible summary. */
export function normalizeRunError(
  details: string,
  translate: RunErrorTranslator = english,
  locale = "en-US",
  now = Date.now(),
): {
  summary: string;
  details: string;
  recovery?: "connection" | "model";
  resetAt?: number;
  kind?: "key" | "credit" | "spending" | "rate" | "auth" | "model";
  period?: "none" | "daily" | "weekly" | "monthly";
} {
  const prefix = details.trim().match(/^(\d{3})\s*:\s*/);
  const body = details.trim().slice(prefix?.[0].length ?? 0);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Plain text is handled below; malformed HTTP envelopes still get a safe summary.
  }
  const record = asRecord(parsed);
  // Preserve only known recovery advice: provider diagnostics can also be plain text.
  if (APP_RUN_ERRORS.has(details.trim())) {
    return { summary: details, details };
  }
  const error = asRecord(record.error);
  const payload = Object.keys(error).length ? error : record;
  const message = typeof payload.message === "string" ? payload.message : body;
  const metadata = asRecord(payload.metadata ?? record.metadata);
  const signals = `${message} ${JSON.stringify(metadata)} ${String(payload.type ?? "")} ${String(payload.code ?? "")}`;
  const status = Number(prefix?.[1] ?? record.status ?? record.code ?? payload.code);
  const provider = /\bopenrouter\b|openrouter_/i.test(signals)
    ? translate("Your OpenRouter")
    : /\bopenai\b|openai_/i.test(signals)
      ? translate("Your OpenAI")
      : /\banthropic\b|anthropic_/i.test(signals)
        ? translate("Your Anthropic")
        : translate("Your model provider");

  let resetAt: number | undefined;
  let kind: "key" | "credit" | "spending" | "rate" | "auth" | "model" | undefined;
  let period: "none" | "daily" | "weekly" | "monthly" | undefined;
  let recovery: "connection" | "model" | undefined;
  let summary = translate("The model provider returned an error.");
  const financialQuota =
    /insufficient[_ ]quota|credits?|funds|spend|budget|billing|openrouter_key_limit/i.test(signals);
  if ((status === 429 || /rate[_ -]limit|too many requests/i.test(signals)) && !financialQuota) {
    recovery = "connection";
    kind = "rate";
    summary = translate("{provider} is rate limiting requests. Try again shortly.", { provider });
  } else if (
    status === 402 ||
    /\b(?:daily|weekly|monthly|usage)[\s\S]{0,30}limit|\b(?:quota|insufficient[_ ](?:quota|credits?|funds)|credit[_ ]balance)\b|(?:key|credit|spend|spending|budget|billing)[\s\S]{0,40}(?:limit|exceed|exhaust|insufficient)|(?:limit|insufficient)[\s\S]{0,30}(?:credit|spend|budget)/i.test(
      signals,
    )
  ) {
    recovery = "connection";
    period = /\bweekly\b/i.test(message)
      ? "weekly"
      : /\bmonthly\b/i.test(message)
        ? "monthly"
        : /\bdaily\b/i.test(message)
          ? "daily"
          : "none";
    kind = /\bkey\b|key_limit/i.test(signals)
      ? "key"
      : /credit|insufficient_quota/i.test(signals)
        ? "credit"
        : "spending";
    summary = translate(RUN_ERROR_LIMIT_MESSAGES[kind][period], { provider });
    const reset =
      message.match(
        /\bresets?(?:\s+at|\s+on)?\s*[:=]?\s*(\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?)/i,
      )?.[1] ??
      metadata.reset_at ??
      metadata.reset;
    if (typeof reset === "string" && /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?$/.test(reset)) {
      const date = new Date(reset);
      if (
        date.getUTCFullYear() === Number(reset.slice(0, 4)) &&
        date.getUTCMonth() + 1 === Number(reset.slice(5, 7)) &&
        date.getUTCDate() === Number(reset.slice(8, 10)) &&
        date.getTime() > now
      ) {
        resetAt = date.getTime();
        summary = translate("{summary} Resets {date}.", {
          summary,
          date: new Intl.DateTimeFormat(locale, {
            month: "short",
            day: "numeric",
            timeZone: "UTC",
          }).format(date),
        });
      }
    }
  } else if (status === 429) {
    recovery = "connection";
    kind = "rate";
    summary = translate("{provider} is rate limiting requests. Try again shortly.", { provider });
  } else if (
    status === 401 ||
    ((status === 403 || /invalid[_ -](?:api[_ -])?key|authentication_error/i.test(signals)) &&
      /auth|unauthorized|forbidden|invalid|key|permission|access denied/i.test(signals))
  ) {
    recovery = "connection";
    kind = "auth";
    summary = translate("{provider} rejected the API key. Check your connection settings.", {
      provider,
    });
  } else if (
    (status === 404 && /model/i.test(signals)) ||
    /model[_ -]not[_ -]found|(?:model[\s\S]{0,40}(?:not found|does not exist|unavailable))/i.test(
      signals,
    )
  ) {
    recovery = "model";
    kind = "model";
    summary = translate("{provider} could not find the requested model.", { provider });
  } else if (
    status === 408 ||
    status === 504 ||
    /timed?[_ -]?out|timeout|ETIMEDOUT/i.test(signals)
  ) {
    summary = translate("{provider} took too long to respond. Try again.", { provider });
  }
  return {
    summary,
    details,
    ...(kind ? { kind } : {}),
    ...(period ? { period } : {}),
    ...(recovery ? { recovery } : {}),
    ...(resetAt ? { resetAt } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
