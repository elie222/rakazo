/** Copy each client supplies in its own language. */
export type UserErrorCopy = { fallback: string; offline: string };

/** Browser, React Native, Expo, and Node wordings for a request that never got a response. */
const NETWORK_FAILURE =
  /^(?:failed to fetch|load failed|fetch failed|network ?error|network request failed)|networkerror when attempting|could not connect to the server|internet connection appears to be offline/i;
const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
]);

/** Implementation detail that should never reach the screen as-is. */
const TECHNICAL_MESSAGE = [
  /\[(?:body|query|params|headers)(?:\.[^\]]*)?\]/, // validation issue paths
  /\w+Exception\b/,
  /^\w*Error:/,
  /\(at \S+:\d+|\bat \S+ \(\S+:\d+(?::\d+)?\)|\.(?:swift|kt|java|mm?|[cm]?[jt]sx?):\d+/, // stack frames
  /^\s*[[{]/, // JSON
  /^rpc \S+ failed|\(\d{3}\)|\bstatus(?: code)? \d{3}\b/i, // HTTP status dumps
  /\bE(?:CONN[A-Z]+|TIMEDOUT|NOTFOUND|AI_AGAIN|PIPE|HOSTUNREACH|NETUNREACH)\b/,
  /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/, // bare internal codes
  /\d+ bytes\b/,
  /unexpected token|is not a function|cannot read propert|undefined is not|null is not an object|json parse error/i,
];

/** True when a thrown value means the server could not be reached at all. */
export function isNetworkFailure(error: unknown): boolean {
  let current = error;
  for (let depth = 0; current instanceof Error && depth < 4; depth += 1) {
    if (NETWORK_FAILURE.test(current.message.trim())) return true;
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && NETWORK_CODES.has(code)) return true;
    current = current.cause;
  }
  return false;
}

export function isTechnicalErrorMessage(message: string): boolean {
  return TECHNICAL_MESSAGE.some((pattern) => pattern.test(message));
}

/**
 * The text to show for a failure: messages written for people (server copy, client copy) pass
 * through; transport failures and implementation detail become the caller's copy.
 */
export function userErrorMessage(error: unknown, copy: UserErrorCopy): string {
  if (isNetworkFailure(error)) return copy.offline;
  const message = (
    error instanceof Error ? error.message : typeof error === "string" ? error : ""
  ).trim();
  return message && !isTechnicalErrorMessage(message) ? message : copy.fallback;
}

export type CredentialField = "email" | "password";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Catches empty or malformed credentials before they round-trip to the server. */
export function credentialIssue(input: {
  email: string;
  password?: string;
}): CredentialField | null {
  if (!EMAIL.test(input.email.trim())) return "email";
  if (input.password !== undefined && !input.password) return "password";
  return null;
}

export type AuthErrorCopy = Record<CredentialField, string> & { fallback: string };

/**
 * Copy for a failed auth response body (`{ code, message }`). Request validation failures name
 * the rejected inputs as issue paths (`[body.email] …`), so map those to field copy.
 */
export function authErrorMessage(body: unknown, copy: AuthErrorCopy): string {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const message = typeof record.message === "string" ? record.message : "";
  if (record.code === "VALIDATION_ERROR") {
    const fields = new Set([...message.matchAll(/\[body\.(\w+)/g)].map((match) => match[1]));
    if (fields.has("email")) return copy.email;
    if (fields.has("password")) return copy.password;
    return copy.fallback;
  }
  return message && !isTechnicalErrorMessage(message) ? message : copy.fallback;
}
