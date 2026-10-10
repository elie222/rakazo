/** Keep provider diagnostics available without exposing them in the visible summary. */
export function normalizeRunError(details: string): { summary: string; details: string } {
  const prefix = details.trim().match(/^(\d{3})\s*:\s*/);
  const body = details.trim().slice(prefix?.[0].length ?? 0);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Plain text and malformed provider responses still get a safe summary.
  }
  const record = asRecord(parsed);
  const error = asRecord(record.error);
  const payload = Object.keys(error).length ? error : record;
  const message = typeof payload.message === "string" ? payload.message : body;
  const metadata = asRecord(payload.metadata ?? record.metadata);
  const signals = `${message} ${JSON.stringify(metadata)} ${String(payload.type ?? "")} ${String(payload.code ?? "")}`;
  const status = Number(prefix?.[1] ?? record.status ?? record.code ?? payload.code);
  const provider = /\bopenrouter\b|openrouter_/i.test(signals)
    ? "Your OpenRouter"
    : /\bopenai\b|openai_/i.test(signals)
      ? "Your OpenAI"
      : /\banthropic\b|anthropic_/i.test(signals)
        ? "Your Anthropic"
        : "Your model provider";

  let summary = "The model provider returned an error.";
  if (
    /\b(?:quota|insufficient[_ ](?:quota|credits?|funds)|credit[_ ]balance)\b|(?:key|credit|spend|spending|budget|billing)[\s\S]{0,40}(?:limit|exceed|exhaust|insufficient)|(?:limit|insufficient)[\s\S]{0,30}(?:credit|spend|budget)/i.test(
      signals,
    )
  ) {
    const period = /\bweekly\b/i.test(message)
      ? "weekly "
      : /\bmonthly\b/i.test(message)
        ? "monthly "
        : /\bdaily\b/i.test(message)
          ? "daily "
          : "";
    const kind = /\bkey\b|key_limit/i.test(signals)
      ? "key"
      : /credit|insufficient_quota/i.test(signals)
        ? "credit"
        : "spending";
    summary =
      kind === "key"
        ? `${provider} key hit its ${period}limit.`
        : `${provider} reached its ${period}${kind} limit.`;
    const reset =
      message.match(
        /\bresets?(?:\s+at|\s+on)?\s*[:=]?\s*(\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?)/i,
      )?.[1] ??
      metadata.reset_at ??
      metadata.reset;
    if (typeof reset === "string" && /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?$/.test(reset)) {
      const date = new Date(reset);
      if (!Number.isNaN(date.getTime())) {
        summary += ` Resets ${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(date)}.`;
      }
    }
  } else if (status === 429 || /rate[_ -]limit|too many requests/i.test(signals)) {
    summary = `${provider} is rate limiting requests. Try again shortly.`;
  } else if (
    status === 401 ||
    ((status === 403 || /invalid[_ -](?:api[_ -])?key|authentication_error/i.test(signals)) &&
      /auth|unauthorized|forbidden|invalid|key|permission|access denied/i.test(signals))
  ) {
    summary = `${provider} rejected the API key. Check your connection settings.`;
  } else if (
    (status === 404 && /model/i.test(signals)) ||
    /model[_ -]not[_ -]found|(?:model[\s\S]{0,40}(?:not found|does not exist|unavailable))/i.test(
      signals,
    )
  ) {
    summary = `${provider} could not find the requested model.`;
  } else if (
    status === 408 ||
    status === 504 ||
    /timed?[_ -]?out|timeout|ETIMEDOUT/i.test(signals)
  ) {
    summary = `${provider} took too long to respond. Try again.`;
  }
  return { summary, details };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
