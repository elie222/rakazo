import type { RunErrorKind } from "@rakazo/contracts";
import { COMPUTER_RATE_LIMIT_ERROR, providerQuotaResetAt } from "@rakazo/contracts";
import { stuckWorkStatusMessages } from "./stuck-work.js";

export const MISSING_TOOL_FINAL_RESPONSE_ERROR =
  "The tools finished, but the model did not write a final answer. Rephrase the request and try again.";

/** Resumed without its saved turn, the model did not call the action the user approved. */
export const APPROVED_ACTION_NOT_RUN_ERROR =
  "The model did not run the approved action. Try again.";

export const MODEL_OUTPUT_LIMIT_ERROR = "The model hit its output limit before writing a response.";

/** The model ran out of output tokens partway through its reply, even after continuing it. */
export const MODEL_OUTPUT_CUT_ERROR = "The model hit its output limit before finishing its reply.";

/** The bot's instructions and tools alone do not fit the selected model's context window. */
export const MODEL_CONTEXT_TOO_SMALL_ERROR =
  "This model's context window is too small. Choose another model.";

/** The provider account's request budget cannot fit the agent's mandatory context. */
export const MODEL_REQUEST_LIMIT_ERROR =
  "This connection's request limit is too small. Choose another model.";

export const MISSING_MODEL_RUN_ERROR = "Connect a model in Settings before running bots.";

/** A deployment model run while the organization has not chosen Rakazo credits. */
export const HOSTED_MODEL_CREDITS_REQUIRED_ERROR =
  "Connect your own API key in Models or choose Rakazo credits in Billing.";

/** A run in a billing organization without a paid plan, credits, or free period. */
export const MODEL_ACCESS_REQUIRED_RUN_ERROR = "Subscribe in Billing to keep running bots.";

/** The API rejects a send with this message until the user can reach a model. */
export const MODEL_REQUIRED_SEND_ERROR = "Connect a model to start a run.";

/** Only the structured server response enables explicit file confirmation. */
export function isImageInputConfirmation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { status?: unknown; data?: { reason?: unknown } };
  return value.status === 409 && value.data?.reason === "model_image_input_unsupported";
}

export const MODEL_IMAGE_INPUT_UNKNOWN = "Image input is not configured for this model.";

export const MODEL_IMAGE_INPUT_ERROR =
  "This model cannot read images. Choose a model that supports images.";

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

/** What the API itself answers for an unexpected failure. */
const INTERNAL_RUN_ERROR = "Internal server error";
// A database client error quotes the query, the server file that ran it and a source excerpt;
// a lost or refused database connection names the database host or the pool.
const DATABASE_ERROR =
  /Invalid `[^`]*` invocation|Transaction API error|Transaction already closed|\b(?:Prisma\w*|DriverAdapter)Error\b|\bDatabaseNotReachable\b|Can't reach database server|timeout exceeded when trying to connect|^Connection terminated(?: unexpectedly| due to connection timeout)?\.?$/m;
// An indented "at …" line that ends in a source location, as a JavaScript stack frame does.
const STACK_FRAME = /^\s+at\s.*(?::\d+:\d+\)?|\((?:<anonymous>|native|index \d+)\))\s*$/;
// A file on the server, never the path part of a web URL: no word character, dot or slash
// before it.
const SERVER_FILE_PATH =
  /file:\/\/\S+|(?<![\w.:/-])\/(?:[\w.@+-]+\/)+[\w@+-]+\.[a-z]{1,5}\b(?::\d+){0,2}/gi;

/**
 * The run error saved for the user's Details view and failure push. Provider messages pass
 * through; a server fault loses its stack frames and file paths, and a database error says
 * nothing of the query.
 */
export function userRunError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    (error instanceof Error && /^(?:Prisma|DriverAdapter)/.test(error.name)) ||
    DATABASE_ERROR.test(message)
  ) {
    return INTERNAL_RUN_ERROR;
  }
  const cleaned = message
    .split("\n")
    .filter((line) => !STACK_FRAME.test(line))
    .join("\n")
    .replace(SERVER_FILE_PATH, "[path]")
    .trim();
  return cleaned || INTERNAL_RUN_ERROR;
}

const MODEL_OUTPUT_RUN_ERRORS = new Set([
  MISSING_TOOL_FINAL_RESPONSE_ERROR,
  APPROVED_ACTION_NOT_RUN_ERROR,
]);
/** App advice whose fix is connecting a model. */
const MODEL_CONNECTION_RUN_ERRORS = new Set([
  MISSING_MODEL_RUN_ERROR,
  HOSTED_MODEL_CREDITS_REQUIRED_ERROR,
]);
const APP_RUN_ERRORS = new Set([
  ...MODEL_OUTPUT_RUN_ERRORS,
  ...MODEL_CONNECTION_RUN_ERRORS,
  MODEL_ACCESS_REQUIRED_RUN_ERROR,
  COMPUTER_RATE_LIMIT_ERROR,
  ...stuckWorkStatusMessages(),
]);

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

/** Read a persisted fallback failure back into its parts; any other text returns undefined. */
export function parseModelFallbackFailure(
  details: string,
): { primaryError: string; backups: ModelBackupOutcome[] } | undefined {
  const record = asRecord(parseJson(details.trim()));
  if (
    record.modelFallbackVersion !== 1 ||
    typeof record.primaryError !== "string" ||
    !Array.isArray(record.backups) ||
    record.backups.length === 0 ||
    !record.backups.every((item: unknown) => {
      const outcome = asRecord(item);
      return (
        typeof outcome.provider === "string" &&
        typeof outcome.modelId === "string" &&
        typeof outcome.reason === "string" &&
        (outcome.status === "failed" || outcome.status === "skipped")
      );
    })
  ) {
    return undefined;
  }
  return { primaryError: record.primaryError, backups: record.backups as ModelBackupOutcome[] };
}

/**
 * Fixed failure strings from the model runtime's stop-reason mapping (including a stop reason
 * it does not know yet, such as Gemini's MALFORMED_RESPONSE, and a refusal), from Anthropic's
 * policy blocks, and from provider APIs that reject a model's malformed tool call or empty
 * reply. Never matched against model prose.
 */
const MODEL_OUTPUT_FAILURE =
  /^(?:Provider (?:finish_reason|stopped with): |Unhandled stop reason: |Provider returned an empty response\b|Failed to parse tool call arguments as JSON\b|Tool call validation failed\b|The model refused to complete the request\b|This request (?:triggered restrictions on [^\n.]{1,80} and )?was blocked (?:under|as it seems to violate) Anthropic's )/;

/** The provider cut off the model's reply, such as a half-written tool call, at its output limit. */
const MODEL_OUTPUT_LIMIT_REACHED = /\bcut ?off by max_(?:completion_|output_)?tokens\b/i;

/**
 * Fetch refuses to send a key that is not a valid header value, such as one pasted with a code
 * sample around it or with non-Latin characters. Its message quotes the key, so it is checked
 * before anything reads that text.
 */
const MALFORMED_KEY_HEADER =
  /^(?:TypeError: )?(?:Headers\.append: "[\s\S]*" is an invalid header value\.|Cannot convert argument to a ByteString because the character at index \d+ has a value of \d+ which is greater than 255\.)$/;

/** The provider says the selected model is gone or cannot serve this kind of request. */
const MODEL_UNAVAILABLE =
  /^(?:unsupported|unknown|unrecognized)[ _-]model\b(?![ :]+(?:parameters?|fields?|options?|settings?)\b)|\bmodel\b(?:(?!\.\s)[\s\S]){0,80}?\b(?:not found|does not exist|unavailable|not available|not supported|isn['\u2019]t supported|(?:is|has been) deprecated|does(?: not|n['\u2019]t) support)\b|\bnot supported (?:with|by|for) (?:this|the) model\b|^feature 'tool calls' is not (?:currently )?supported\b/i;

/**
 * Keep provider diagnostics available without exposing them in the visible summary. `recovery`
 * is the one action that fixes the failure: "connection" opens the model connections (a
 * rejected or capped key, or no model at all) and "model" picks another model (a provider out
 * of quota or credits, refusing the model to the account, or unable to serve it). Transient
 * failures carry none: their summary already says to try again.
 */
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
  if ([MODEL_IMAGE_INPUT_ERROR, MODEL_IMAGE_INPUT_UNKNOWN].includes(trimmed)) {
    return {
      summary: translate(trimmed),
      details,
      recovery: "model",
      kind: "model",
    };
  }
  // "429: {...}", "429 {...}", or the model runtime's "<provider> API error (429): {...}".
  const prefix = trimmed.match(
    /^(?:[^\n():]{1,60} API error \((\d{3})\):\s*|(\d{3})(?:\s*:\s*|\s+))/,
  );
  const body = trimmed.slice(prefix?.[0].length ?? 0);
  const record = asRecord(parseJson(body));
  const fallback = parseModelFallbackFailure(trimmed);
  if (fallback) {
    const primary = normalizeRunError(fallback.primaryError, translate, locale, now);
    const failed = fallback.backups.some((item) => item.status === "failed");
    const skipped = fallback.backups.some((item) => item.status === "skipped");
    const message = failed
      ? skipped
        ? "{summary} Backup models failed or were unavailable for this request."
        : "{summary} Your backup models also failed."
      : "{summary} No backup model was usable for this request.";
    return {
      ...primary,
      summary: translate(message, { summary: primary.summary }),
      // One diagnostic line per model instead of the persisted JSON envelope.
      details: [
        fallback.primaryError,
        ...fallback.backups.map((item) => `${item.provider} ${item.modelId}: ${item.reason}`),
      ].join("\n"),
    };
  }
  // Preserve only known recovery advice: provider diagnostics can also be plain text.
  if (APP_RUN_ERRORS.has(trimmed)) {
    return MODEL_OUTPUT_RUN_ERRORS.has(trimmed)
      ? { summary: details, details, kind: "output" }
      : MODEL_CONNECTION_RUN_ERRORS.has(trimmed)
        ? { summary: translate(trimmed), details, recovery: "connection" }
        : { summary: details, details };
  }
  if (trimmed === MODEL_OUTPUT_CUT_ERROR) {
    return {
      summary: translate(MODEL_OUTPUT_CUT_ERROR),
      details,
      recovery: "model",
      kind: "output",
    };
  }
  if (trimmed === MODEL_CONTEXT_TOO_SMALL_ERROR || trimmed === MODEL_REQUEST_LIMIT_ERROR) {
    return {
      summary: translate(trimmed),
      details,
      recovery: "model",
      kind: "context",
    };
  }
  if (MALFORMED_KEY_HEADER.test(trimmed)) {
    return {
      summary: translate("{provider} rejected the API key. Check your connection settings.", {
        provider: translate("Your model provider"),
      }),
      details,
      recovery: "connection",
      kind: "auth",
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
  // A 429 that resets hours from now is a quota to wait out, not a short rate window.
  const quotaResetAt = status === 429 ? providerQuotaResetAt(trimmed, now) : undefined;
  if (
    status !== 413 &&
    quotaResetAt === undefined &&
    (status === 429 ||
      /rate[_ -]limit|too many requests|resource[_ ]?exhausted|request limit reached/i.test(
        signals,
      )) &&
    // OpenAI's per-minute limits link to billing as a way to raise them.
    (!financialQuota || /\b(?:rpm|tpm)\b/i.test(signals))
  ) {
    kind = "rate";
    summary = translate("{provider} is rate limiting requests. Try again shortly.", { provider });
  } else if (
    status === 402 ||
    quotaResetAt !== undefined ||
    /\b(?:daily|weekly|monthly|usage)[\s\S]{0,30}limit|\b(?:quota|insufficient[_ ](?:quota|credits?|funds|balance)|credit[_ ]balance|(?:no|out of|more) credits?)\b|(?:key|credit|spend|spending|budget|billing)[\s\S]{0,40}(?:limit|exceed|exhaust|insufficient)|(?:limit|insufficient)[\s\S]{0,30}(?:credit|spend|budget)/i.test(
      signals,
    )
  ) {
    // "Monthly included credits" in an upsell names no limit period.
    const limitPeriod = message.match(
      /\b(daily|weekly|monthly)\b(?:\s+\w+){0,2}\s+(?:limit|quota|cap|budget)|\b(?:limit|quota)\b[^.]{0,20}?\b(daily|weekly|monthly)\b|\bper[ -](day)\b/i,
    );
    period = limitPeriod?.[3]
      ? "daily"
      : (((limitPeriod?.[1] ?? limitPeriod?.[2])?.toLowerCase() as
          | "daily"
          | "weekly"
          | "monthly"
          | undefined) ?? "none");
    // OpenRouter names the limit that tripped. "Make sure your key is on the correct account"
    // in a credit error is not a key limit.
    const limitSource = typeof metadata.limit_source === "string" ? metadata.limit_source : "";
    kind = (
      limitSource
        ? /key_limit/.test(limitSource)
        : /key[_ ]limit|\bkey\b[^.]{0,30}\blimit\b/i.test(signals)
    )
      ? "key"
      : /credit|insufficient_quota|free[_ -]tier/i.test(signals)
        ? "credit"
        : "spending";
    // A capped key is fixed by connecting another; an account out of money or quota is not, but
    // another model keeps the user going.
    recovery = kind === "key" ? "connection" : "model";
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
      }
    }
    resetAt ??= quotaResetAt;
    if (resetAt !== undefined) {
      summary = translate("{summary} Resets {date}.", {
        summary,
        date: new Intl.DateTimeFormat(locale, {
          month: "short",
          day: "numeric",
          timeZone: "UTC",
        }).format(resetAt),
      });
    }
  } else if (
    typeof payload.param === "string" &&
    /^max_(?:completion_|output_)?tokens$/.test(payload.param)
  ) {
    // The model's own output cap is below what every run asks for, so retrying cannot help.
    recovery = "model";
    kind = "context";
    summary = translate(MODEL_CONTEXT_TOO_SMALL_ERROR);
  } else if (
    status === 413 ||
    /context[_ -](?:length|size|window)|maximum context|exceeds the model context|prompt is too long|too many tokens|request too large/i.test(
      signals,
    )
  ) {
    kind = "context";
    summary = translate(
      "This conversation is too long for the model. Retrying won't help. Start a new chat or shorten your message.",
    );
  } else if (status === 429) {
    kind = "rate";
    summary = translate("{provider} is rate limiting requests. Try again shortly.", { provider });
  } else if (
    status === 401 ||
    ((status === 403 ||
      /(?:invalid|incorrect)[_ -](?:api[_ -])?key|api[_ -]?key[_ -](?:invalid|expired)|authentication_error|\bauthentication token (?:has|is) expired\b|\binvalidated oauth token\b/i.test(
        signals,
      )) &&
      /auth|unauthorized|invalid|key/i.test(signals))
  ) {
    recovery = "connection";
    kind = "auth";
    summary = translate("{provider} rejected the API key. Check your connection settings.", {
      provider,
    });
  } else if (status === 403 || payload.code === "model_terms_required") {
    // The key works, but the provider refuses this model to the account or plan, or serves it
    // only inside its own apps.
    recovery = "model";
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
    summary = translate("{provider} can't run this model.", { provider });
  } else if (
    status === 502 ||
    status === 503 ||
    status === 529 ||
    /overload|over capacity|temporarily unavailable|service unavailable/i.test(signals)
  ) {
    summary = translate("{provider} is overloaded right now. Try again in a moment.", { provider });
  } else if (
    // The provider SDKs report a refused or unresolvable host as a bare "Connection error.".
    /^connection error\.?$/i.test(message.trim()) ||
    /ECONNREFUSED|connection refused|ENOTFOUND|getaddrinfo|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN/i.test(
      signals,
    )
  ) {
    summary = translate("{provider} couldn't be reached. Check that it's running.", { provider });
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
    MODEL_OUTPUT_FAILURE.test(message) ||
    MODEL_OUTPUT_LIMIT_REACHED.test(message)
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
