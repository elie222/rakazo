/** Placeholder written over OTP codes and credential URLs in mail read payloads. */
export const MAIL_CREDENTIAL_REDACTION = "[redacted-credential]";

const MAIL_CONNECTOR_SLUGS = new Set([
  "gmail",
  "googlemail",
  "outlook",
  "microsoft_outlook",
  "microsoftoutlook",
  "imap",
]);

/** Labeled one-time codes: verification/OTP/passcode followed by 4-8 digits. */
const LABELED_OTP_PATTERN =
  /\b((?:one[\s-]?time(?:\s+pass(?:code|word))?|otp|verification|authentication|auth|security|login|email|access)?\s*(?:code|passcode|pin))\s*(?:is|=|:)?\s*[#:]?\s*[0-9](?:[\s-]?[0-9]){3,7}\b/gi;

/** Password-reset HTTPS URLs (path or host cues). */
const PASSWORD_RESET_URL_PATTERN =
  /https:\/\/[^\s<>"'\\]+(?:reset(?:[\s/_-]?password)?|password(?:[\s/_-]?reset)|pwdreset|passwd|change(?:[\s/_-]?password)|account(?:[\s/_-]?recover(?:y)?))[^\s<>"'\\]*/gi;

/** Magic-link style HTTPS URLs with credential query parameters. */
const MAGIC_LINK_QUERY_PATTERN =
  /https:\/\/[^\s<>"'\\]+[?&](?:(?:magic|auth|access|reset|verify|confirmation|otp|login)[_-]?(?:token|link|code)|token|code)=[^\s<>"'\\]+/gi;

/** Magic-link style HTTPS URLs identified by path segments. */
const MAGIC_LINK_PATH_PATTERN =
  /https:\/\/[^\s<>"'\\]+\/(?:magic(?:[_-]?(?:link|token))?|auth\/(?:magic|link)|verify(?:[_-]?email)?|signin\/(?:link|magic)|login\/(?:link|magic)|session\/(?:link|magic))[^\s<>"'\\]*/gi;

function normalizeSlug(value: string): string {
  return value.trim().toLowerCase().replace(/-/g, "_");
}

function connectorSlugFromToolName(toolName: string): string {
  const [segment] = toolName.split(/_|\./);
  return normalizeSlug(segment ?? toolName);
}

/**
 * True when a connector tool is mail-related (Gmail, Outlook, or generic mail/imap/inbox).
 * Used to scope credential redaction to mail connector read results.
 */
export function isMailConnectorTool(
  toolName: string,
  options?: { connectorSlug?: string; resourceId?: string },
): boolean {
  const slug = normalizeSlug(options?.connectorSlug ?? "");
  const resourceId = normalizeSlug(options?.resourceId ?? "");
  if (MAIL_CONNECTOR_SLUGS.has(slug) || MAIL_CONNECTOR_SLUGS.has(resourceId)) return true;
  if (MAIL_CONNECTOR_SLUGS.has(connectorSlugFromToolName(toolName))) return true;

  const tool = toolName.toLowerCase();
  if (/(^|_|\/)(gmail|googlemail|outlook|microsoft_outlook|microsoftoutlook)(_|$|\/)/i.test(tool)) {
    return true;
  }
  // Generic mail connectors (installed OpenAPI / MCP / IMAP-style tools).
  if (/(^|_|\/)(mail|email|imap|inbox)(_|$|\/)/i.test(tool)) return true;
  if (/(^|_)(mail|email|imap|inbox|outlook|gmail)($|_)/i.test(resourceId)) return true;
  return false;
}

/**
 * True for mail tools that return message content to the model (list/fetch/read).
 * Send/draft mutations are excluded; their results are not inbox bodies.
 */
export function isMailConnectorReadTool(
  toolName: string,
  options?: { connectorSlug?: string; resourceId?: string },
): boolean {
  if (!isMailConnectorTool(toolName, options)) return false;
  const tool = toolName.toLowerCase();
  if (
    /(^|_)(send|create|draft|delete|trash|archive|forward|reply|move|label|modify|update|upsert|write)(_|$)/i.test(
      tool,
    )
  ) {
    return false;
  }
  return true;
}

/** Deterministic redaction of OTP-like codes and credential URLs in free text. */
export function redactMailCredentialText(text: string): string {
  return text
    .replace(PASSWORD_RESET_URL_PATTERN, MAIL_CREDENTIAL_REDACTION)
    .replace(MAGIC_LINK_QUERY_PATTERN, MAIL_CREDENTIAL_REDACTION)
    .replace(MAGIC_LINK_PATH_PATTERN, MAIL_CREDENTIAL_REDACTION)
    .replace(LABELED_OTP_PATTERN, `${MAIL_CREDENTIAL_REDACTION}`);
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactMailCredentialText(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        redactMailCredentialText(key),
        redactValue(item),
      ]),
    );
  }
  return value;
}

/**
 * Redact OTP / reset / magic-link material from a mail connector read payload.
 * Non-mail tools and mail mutations are returned unchanged.
 */
export function redactMailConnectorReadPayload(
  toolName: string,
  payload: unknown,
  options?: { connectorSlug?: string; resourceId?: string },
): unknown {
  if (!isMailConnectorReadTool(toolName, options)) return payload;
  try {
    return redactValue(JSON.parse(JSON.stringify(payload)));
  } catch {
    if (typeof payload === "string") return redactMailCredentialText(payload);
    return payload;
  }
}
