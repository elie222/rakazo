/** A model call failed for a reason that should clear on its own, such as an overloaded provider. */
export class TransientModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientModelError";
  }
}

function errorFacts(value: unknown) {
  const text: string[] = [];
  const statuses = new Set<number>();
  const seen = new Set<object>();
  const visit = (item: unknown, depth: number) => {
    if (depth > 4 || item == null) return;
    if (typeof item === "string") {
      text.push(item);
      return;
    }
    if (typeof item !== "object" || seen.has(item)) return;
    seen.add(item);
    const record = item as Record<string, unknown>;
    for (const key of ["message", "errorMessage", "name", "code", "type"]) {
      if (typeof record[key] === "string") text.push(record[key] as string);
    }
    for (const key of ["status", "statusCode", "httpStatus"]) {
      if (typeof record[key] === "number") statuses.add(record[key] as number);
    }
    for (const key of ["response", "cause", "details", "diagnostics", "data", "error"]) {
      visit(record[key], depth + 1);
    }
    if (Array.isArray(item)) for (const child of item) visit(child, depth + 1);
  };
  visit(value, 0);
  for (const detail of text) {
    for (const match of detail.matchAll(
      /(?:\b(?:http(?:\s+status(?:\s+code)?)?|status(?:\s+code)?|error\s+code)\s*[:=]?\s*|^\s*)([45]\d{2})\b/gi,
    )) {
      statuses.add(Number(match[1]));
    }
  }
  return { text: text.join(" ").toLowerCase(), statuses };
}

/** A timed-out request already spent its full budget, so it is not worth an immediate retry. */
export function isProviderTimeout(error: unknown): boolean {
  return /timed? out|timeout/.test(errorFacts(error).text);
}

/** Only provider availability failures may advance the user's explicit chain. */
export function isRetryableProviderUnavailable(error: unknown): boolean {
  const { text, statuses } = errorFacts(error);
  if (statuses.has(400) || statuses.has(401)) return false;
  // Kimi For Coding reports an exhausted usage window as HTTP 403. errorFacts lowercases text.
  if (
    statuses.has(403) &&
    /you['\u2019]ve reached your (?:5-hour usage limit|weekly \(7-day\) usage limit|monthly usage limit|usage limit for this billing cycle)/.test(
      text,
    )
  ) {
    return true;
  }
  if (
    [400, 401, 403].some((status) => statuses.has(status)) ||
    /\b(?:http(?:\s+status(?:\s+code)?)?|status(?:\s+code)?|error\s+code)\s*[:=]?\s*(?:400|401|403)\b/.test(
      text,
    )
  ) {
    return false;
  }
  if (
    /\b(abort(?:ed)?|cancel(?:lation|led|ed)?|unauthori[sz]ed|forbidden|permission(?: is)? (?:denied|refused|declined)|access denied|consent(?: is)? (?:required|denied|refused|declined|not granted)|user (?:refused|declined)|invalid api key|invalid credential|(?:expired|revoked|missing) (?:api )?(?:key|credential|token)|(?:api )?key (?:expired|revoked|missing)|authentication (?:failed|failure|denied|expired|invalid)|authorization (?:failed|failure|denied|expired|invalid)|bad request|invalid request|invalid input|invalid argument|context length|model not found|unsupported parameter)\b/.test(
      text,
    )
  ) {
    return false;
  }
  if (
    /context[ _-](?:length|window)|too many tokens|maximum context|token limit|request too large|invalid_api_key|authentication_error|permission_error|bad_request|invalid_request/.test(
      text,
    )
  )
    return false;
  if (statuses.has(402)) {
    return /quota|billing|credit|payment limit|insufficient funds/.test(text);
  }
  if (
    [408, 429].some((status) => statuses.has(status)) ||
    [...statuses].some((status) => status >= 500 && status < 600)
  )
    return true;
  if ([...statuses].some((status) => status >= 400 && status < 600)) return false;
  return /rate.?limit|too many requests|quota|overload|capacity|temporarily unavailable|service unavailable|retry[- ](?:after|delay)|server error|upstream error|gateway timeout|timed? out|timeout|connection reset|connection refused|network error|max retries exceeded|stream ended without finish_reason|\bterminated\b|fetch failed|socket hang up|econnreset|econnrefused|etimedout|websocket closed/.test(
    text,
  );
}

/**
 * Overload, rate limit, 5xx, timeout or dropped connection. Quota, billing, auth and input
 * errors are permanent. Runtimes often expose only a message, so this reads text as well as
 * structured status fields.
 */
export function isTransientModelError(error: unknown): boolean {
  return (
    isRetryableProviderUnavailable(error) &&
    !/insufficient_quota|exceeded your current quota|quota exhausted|usage limit|billing|credit balance|insufficient (?:funds|balance|credits)|payment|out of budget/.test(
      errorFacts(error).text,
    )
  );
}
