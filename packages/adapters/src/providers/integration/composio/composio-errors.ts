/** A timeout, dropped connection, cancellation, rate limit or server error from the API. The
 * client sets `status` on every API error and leaves it unset when no response came back. */
export function isComposioOutage(error: unknown): boolean {
  if (!(error instanceof Error) || !("status" in error) || !("headers" in error)) return false;
  const status = error.status;
  if (status === undefined) return true;
  return typeof status === "number" && (status === 408 || status === 429 || status >= 500);
}

/** The session named a connected account the provider no longer has for this user. */
export function isStaleConnectedAccountError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { status?: unknown; details?: { slug?: unknown } };
  return (
    candidate.status === 400 &&
    candidate.details?.slug === "ToolRouterV2_InvalidConnectedAccountIds"
  );
}

/** The connected account ids a stale-account refusal names. */
export function staleAccountIds(error: unknown): Set<string> {
  const message = (error as { details?: { message?: unknown } }).details?.message;
  return new Set(typeof message === "string" ? (message.match(/\bca_[A-Za-z0-9_-]+/g) ?? []) : []);
}

export function collectLogIds(value: unknown): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const record = node as Record<string, unknown>;
    for (const [key, nested] of Object.entries(record)) {
      if (
        (key === "logId" || key === "log_id") &&
        typeof nested === "string" &&
        nested &&
        !seen.has(nested)
      ) {
        seen.add(nested);
        ids.push(nested);
      } else {
        walk(nested);
      }
    }
  };
  walk(value);
  return ids;
}

export function isNoAuthToolkitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("ToolkitsIsNoAuth") || message.includes("does not require authentication")
  );
}

/** Composio has no managed OAuth app for the toolkit and the project has no auth config of its own. */
export function isNoManagedAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("ToolRouterV2_NoManagedAuth");
}

/**
 * COMPOSIO_MULTI_EXECUTE_TOOL reports a failed batch as "N out of M tools
 * failed" and puts each tool's real error in `data.results`. Keep those, or the
 * model cannot tell "message not found" apart from a broken integration.
 */
export function composioResultError(summary: string, data: unknown): string {
  const results = (data as { results?: unknown } | null | undefined)?.results;
  if (!Array.isArray(results)) return summary;
  const details = results.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as {
      tool_slug?: unknown;
      error?: unknown;
      response?: { error?: unknown } | null;
    };
    const error = [item.error, item.response?.error].find(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    if (!error) return [];
    const redacted = redactConnectorText(error);
    const detail = redacted.length > 500 ? `${redacted.slice(0, 500)}…` : redacted;
    return [typeof item.tool_slug === "string" ? `${item.tool_slug}: ${detail}` : detail];
  });
  if (details.length === 0) return summary;
  const shown = details.slice(0, 5);
  const more = details.length - shown.length;
  return `${summary}: ${shown.join("; ")}${more > 0 ? `; +${more} more` : ""}`;
}

const SHARED_ACCESS_SCOPE =
  /\b(?:Mail|Calendars|Contacts|Tasks)\.(?:Read|ReadBasic|ReadWrite|Send)\.Shared(?![A-Za-z0-9_]|\.[A-Za-z0-9])/;

/**
 * A connection made without a delegated "shared" scope is refused for any mailbox or
 * calendar but the user's own, and only a new connection carries the scope.
 */
export function withSharedAccessHint(message: string): string {
  const scope = SHARED_ACCESS_SCOPE.exec(message)?.[0];
  if (!scope) return message;
  let end = message.length;
  while (end > 0 && (message[end - 1] === "." || message[end - 1]?.trim() === "")) end--;
  return `${message.slice(0, end)}. This call needs the ${scope} permission; reconnect if the connection was made before it was added.`;
}

export function sanitizeIntegrationError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactConnectorText(message);
}

const CREDENTIAL_FIELD_NAME =
  "composio[_-]?api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|client[_-]?secret|api[_-]?key|password|passwd|secret";

const CREDENTIAL_FIELD_KEY = new RegExp(`^(?:${CREDENTIAL_FIELD_NAME})$`, "i");

const CREDENTIAL_ASSIGNMENT = new RegExp(
  `(["']?\\b(?:${CREDENTIAL_FIELD_NAME})\\b["']?\\s*[=:]\\s*)` +
    `(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^\\s,&;}]+(?:;(?![A-Za-z0-9_]+[=:])[^\\s,&;}]+)*)`,
  "gi",
);

export function sanitizePayload(data: unknown): unknown {
  return redactConnectorData(data);
}

function redactConnectorData(data: unknown): unknown {
  if (typeof data === "string") return redactConnectorText(data);
  if (Array.isArray(data)) return data.map((item) => redactConnectorData(item));
  if (!data || typeof data !== "object") return data;
  const seen = new Map<string, number>();
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [
      distinctRedactedKey(redactSecretLiterals(key), seen),
      isCredentialField(key) ? "[redacted]" : redactConnectorData(value),
    ]),
  );
}

function distinctRedactedKey(key: string, seen: Map<string, number>): string {
  const count = (seen.get(key) ?? 0) + 1;
  seen.set(key, count);
  return count === 1 ? key : `${key}~${count}`;
}

function isCredentialField(key: string): boolean {
  return CREDENTIAL_FIELD_KEY.test(key);
}

function redactConnectorText(value: string): string {
  return redactSecretLiterals(
    value
      .replace(CREDENTIAL_ASSIGNMENT, '$1"[redacted]"')
      .replace(
        /COMPOSIO_API_KEY(?!\s*[=:])\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+)/gi,
        "COMPOSIO_API_KEY=[redacted]",
      ),
  );
}

function redactSecretLiterals(value: string): string {
  return value
    .replace(/ak_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/ck_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/sk-or-v1-[A-Za-z0-9]+/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
}
