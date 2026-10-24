import { stuckWorkStatusMessages } from "./stuck-work.js";

export const MISSING_TOOL_FINAL_RESPONSE_ERROR =
  "The tools finished, but the model did not write a final answer. Rephrase the request and try again.";

/** The model ran out of output tokens before writing anything the run could use. */
export const MODEL_OUTPUT_LIMIT_ERROR = "The model hit its output limit before writing a response.";

/** The bot's instructions and tools alone do not fit the selected model's context window. */
export const MODEL_CONTEXT_TOO_SMALL_ERROR =
  "This model's context window is too small. Choose another model.";

/** The API rejects a send with this message until the user can reach a model. */
export const MODEL_REQUIRED_SEND_ERROR = "Connect a model to start a run.";

/** Recognize the send rejection across RPC errors and persisted outbox messages. */
export function isModelRequiredSendError(error: unknown): boolean {
  const message =
    typeof error === "string"
      ? error
      : error !== null && typeof error === "object" && "message" in error
        ? error.message
        : undefined;
  return typeof message === "string" && message.trim() === MODEL_REQUIRED_SEND_ERROR;
}

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

export type ModelBackupOutcome = {
  provider: string;
  modelId: string;
  status: "failed" | "skipped";
  reason: string;
};

/** Persist fallback outcomes with the original failure, without changing provider diagnostics. */
export function modelFallbackFailure(primaryError: string, backups: ModelBackupOutcome[]): string {
  return JSON.stringify({ modelFallbackVersion: 1, primaryError, backups });
}

/**
 * Whose problem a failed run is. Every kind except "output" is the user's provider account,
 * key, plan or model choice; "output" is a model that returned nothing usable.
 */
export type RunErrorKind =
  | "key"
  | "credit"
  | "spending"
  | "rate"
  | "auth"
  | "access"
  | "model"
  | "context"
  | "output";

/**
 * Fixed failure strings from the model runtime's stop-reason mapping and from provider APIs
 * that reject a model's malformed tool call or empty reply. Never matched against model prose.
 */
const MODEL_OUTPUT_FAILURE =
  /^(?:Provider (?:finish_reason|stopped with): |Provider returned an empty response\b|Failed to parse tool call arguments as JSON\b|Tool call validation failed\b)/;

/** The provider says the selected model is gone or cannot serve this kind of request. */
const MODEL_UNAVAILABLE =
  /\bmodel\b(?:(?!\.\s)[\s\S]){0,80}?\b(?:not found|does not exist|unavailable|not available|not supported|isn['\u2019]t supported|(?:is|has been) deprecated|does(?: not|n['\u2019]t) support)\b|\bnot supported (?:with|by|for) (?:this|the) model\b/i;

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
  kind?: RunErrorKind;
  period?: "none" | "daily" | "weekly" | "monthly";
} {
  const trimmed = details.trim();
  // "429: {...}", "429 {...}", or the model runtime's "<provider> API error (429): {...}".
  const prefix = trimmed.match(
    /^(?:[^\n():]{1,60} API error \((\d{3})\):\s*|(\d{3})(?:\s*:\s*|\s+))/,
  );
  const body = trimmed.slice(prefix?.[0].length ?? 0);
  const record = asRecord(parseJson(body));
  if (
    record.modelFallbackVersion === 1 &&
    typeof record.primaryError === "string" &&
    Array.isArray(record.backups) &&
    record.backups.length > 0 &&
    record.backups.every((item: unknown) => {
      const outcome = asRecord(item);
      return (
        typeof outcome.provider === "string" &&
        typeof outcome.modelId === "string" &&
        typeof outcome.reason === "string" &&
        (outcome.status === "failed" || outcome.status === "skipped")
      );
    })
  ) {
    const primary = normalizeRunError(record.primaryError, translate, locale, now);
    const failed = record.backups.some((item) => item.status === "failed");
    const skipped = record.backups.some((item) => item.status === "skipped");
    const message = failed
      ? skipped
        ? "{summary} Backup models failed or were unavailable for this request."
        : "{summary} Your backup models also failed."
      : "{summary} No backup model was usable for this request.";
    return {
      ...primary,
      summary: translate(message, { summary: primary.summary }),
      details,
    };
  }
  // Preserve only known recovery advice: provider diagnostics can also be plain text.
  if (APP_RUN_ERRORS.has(trimmed)) {
    return trimmed === MISSING_TOOL_FINAL_RESPONSE_ERROR
      ? { summary: details, details, kind: "output" }
      : { summary: details, details };
  }
  if (trimmed === MODEL_CONTEXT_TOO_SMALL_ERROR) {
    return {
      summary: translate(MODEL_CONTEXT_TOO_SMALL_ERROR),
      details,
      recovery: "model",
      kind: "context",
    };
  }
  const error = asRecord(record.error);
  let payload = Object.keys(error).length ? error : record;
  // Gateways in front of Google pass Google's own error envelope as a JSON string message.
  const wrapped =
    typeof payload.message === "string" ? asRecord(asRecord(parseJson(payload.message)).error) : {};
  if (Object.keys(wrapped).length) payload = wrapped;
  const message = typeof payload.message === "string" ? payload.message : body;
  const metadata = asRecord(payload.metadata ?? record.metadata);
  const signals = [
    message,
    JSON.stringify(metadata),
    JSON.stringify(payload.details ?? ""),
    ...[payload.type, payload.code, payload.status, payload.param].map((value) =>
      String(value ?? ""),
    ),
  ].join(" ");
  const status =
    [prefix?.[1], prefix?.[2], record.status, record.code, payload.code, payload.httpCode]
      .map(Number)
      .find((value) => Number.isInteger(value) && value >= 100 && value <= 599) ??
    // Bedrock names its modeled exception instead of reporting the HTTP status.
    (/^AccessDeniedException\b/.test(trimmed) ? 403 : undefined);
  const provider = /\bopenrouter\b|openrouter_/i.test(signals)
    ? translate("Your OpenRouter")
    : /\bopenai\b|openai_/i.test(signals)
      ? translate("Your OpenAI")
      : /\banthropic\b|anthropic_/i.test(signals)
        ? translate("Your Anthropic")
        : translate("Your model provider");

  let resetAt: number | undefined;
  let kind: RunErrorKind | undefined;
  let period: "none" | "daily" | "weekly" | "monthly" | undefined;
  let recovery: "connection" | "model" | undefined;
  let summary = translate("The model provider returned an error.");
  const financialQuota =
    /insufficient[_ ](?:quota|balance)|credits?|funds|spend|budget|billing|openrouter_key_limit/i.test(
      signals,
    );
  if ((status === 429 || /rate[_ -]limit|too many requests/i.test(signals)) && !financialQuota) {
    recovery = "connection";
    kind = "rate";
    summary = translate("{provider} is rate limiting requests. Try again shortly.", { provider });
  } else if (
    status === 402 ||
    /\b(?:daily|weekly|monthly|usage)[\s\S]{0,30}limit|\b(?:quota|insufficient[_ ](?:quota|credits?|funds|balance)|credit[_ ]balance|(?:no|out of|more) credits?)\b|(?:key|credit|spend|spending|budget|billing)[\s\S]{0,40}(?:limit|exceed|exhaust|insufficient)|(?:limit|insufficient)[\s\S]{0,30}(?:credit|spend|budget)/i.test(
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
  } else if (
    status === 413 ||
    /context[_ -](?:length|window)|maximum context|exceeds the model context|prompt is too long|too many tokens|request too large/i.test(
      signals,
    )
  ) {
    kind = "context";
    summary = translate(
      "This conversation is too long for the model. Retrying won't help. Start a new chat or shorten your message.",
    );
  } else if (status === 429) {
    recovery = "connection";
    kind = "rate";
    summary = translate("{provider} is rate limiting requests. Try again shortly.", { provider });
  } else if (
    status === 401 ||
    ((status === 403 ||
      /(?:invalid|incorrect)[_ -](?:api[_ -])?key|api[_ -]?key[_ -](?:invalid|expired)|authentication_error/i.test(
        signals,
      )) &&
      /auth|unauthorized|invalid|key/i.test(signals))
  ) {
    recovery = "connection";
    kind = "auth";
    summary = translate("{provider} rejected the API key. Check your connection settings.", {
      provider,
    });
  } else if (status === 403) {
    // The key works, but the provider refuses this model to the account or plan.
    recovery = "connection";
    kind = "access";
    summary = translate("{provider} denied access to this model.", { provider });
  } else if (
    status === 404 ||
    status === 410 ||
    payload.param === "model" ||
    /model[_ -]not[_ -](?:found|supported)/i.test(signals) ||
    (!(status !== undefined && status >= 500) && MODEL_UNAVAILABLE.test(message))
  ) {
    recovery = "model";
    kind = "model";
    summary = translate("{provider} could not find the requested model.", { provider });
  } else if (
    status === 502 ||
    status === 503 ||
    status === 529 ||
    /overload|over capacity|temporarily unavailable|service unavailable/i.test(signals)
  ) {
    summary = translate("{provider} is overloaded right now. Try again in a moment.", { provider });
  } else if (
    status === 408 ||
    status === 504 ||
    /timed?[_ -]?out|timeout|ETIMEDOUT|stream ended|\bterminated\b|socket hang up|ECONNRESET|connection reset|fetch failed|network error/i.test(
      signals,
    )
  ) {
    summary = translate("{provider} took too long to respond. Try again.", { provider });
  } else if (
    trimmed === MODEL_OUTPUT_LIMIT_ERROR ||
    MODEL_OUTPUT_FAILURE.test(trimmed) ||
    MODEL_OUTPUT_FAILURE.test(message)
  ) {
    recovery = "model";
    kind = "output";
    summary = translate("The model returned an unusable response. Try again.");
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

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Plain text is handled by the caller; malformed HTTP envelopes still get a safe summary.
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
