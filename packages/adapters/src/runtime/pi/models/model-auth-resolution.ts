import type { OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { ModelCredentialFailedState, ModelCredentialRetireReason } from "@rakazo/adapter-kit";
import { canonicalPiProviderId } from "@rakazo/contracts";
import { getLogger } from "@rakazo/logging";
import type { StoredModelSecret } from "../../../models/model-secret.js";
import {
  keptModelSettings,
  parseModelSecret,
  serializeModelSecret,
} from "../../../models/model-secret.js";

export const MIN_OAUTH_VALIDITY_MS = 5 * 60 * 1000;

const TERMINAL_REFRESH_ERROR_MARKERS = [
  "invalid_grant",
  "refresh_token_expired",
  "refresh_token_reused",
  "refresh_token_invalidated",
  // pi's Kimi Coding refresh reports a dead credential (401, 403, or a body
  // `error: "invalid_grant"`) as this message without embedding the OAuth
  // marker text itself.
  "Kimi Code token refresh unauthorized",
] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Word-ish boundaries keep `invalid_grant` from matching a longer token such
// as `not_invalid_grant`, while still matching the quoted JSON bodies pi embeds
// in its refresh errors.
const TERMINAL_REFRESH_ERROR_PATTERNS = TERMINAL_REFRESH_ERROR_MARKERS.map(
  (marker) =>
    [marker, new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(marker)}([^A-Za-z0-9_]|$)`)] as const,
);

// pi embeds the token endpoint's HTTP status in provider-specific shapes; match only
// those anchored shapes, since a loose `\d{3}` would match numbers quoted in bodies.
const REFRESH_ERROR_STATUS_PATTERNS = [
  /\bHTTP (\d{3})\b/gi,
  /\bstatus[= ](\d{3})\b/gi,
  /\((\d{3})\)/g,
  /^(\d{3})(?=[\s:])/g,
];

// OAuth terminal rejections arrive as 400/401/403; a 5xx or unparseable status
// stays transient even when the response body quotes a marker.
const TERMINAL_REFRESH_HTTP_STATUSES = new Set([400, 401, 403]);

// A layer's own status lives in pi's header formatting, before the embedded
// response payload. Everything past the first payload marker — `): ` closing a
// parenthesized status, `: {` opening a JSON body, `body=`/`stack=` fields in
// Anthropic's flattened details, a bare `500: ` ending a flat status header,
// or the `: ` after a Copilot-style leading status — is quoted server text
// where a mention like "status 502" must not veto (or grant) terminality.
function statusHeader(message: string): string {
  let end = message.length;
  const cutAt = (index: number, keep = 0) => {
    if (index >= 0) end = Math.min(end, index + keep);
  };
  cutAt(message.indexOf("): "), 1); // keep ")" so `(400)` still parses
  cutAt(message.indexOf(": {"), 1);
  cutAt(message.indexOf("body="));
  cutAt(message.indexOf("stack="));
  const flat = /(\d{3}): /.exec(message);
  if (flat && message.charAt(flat.index - 1) !== "(") {
    // Keep the 3 status digits so the flat header still parses.
    end = Math.min(end, flat.index + 3);
  }
  if (/^\d{3}[\s:]/.test(message)) cutAt(message.indexOf(": "), 1);
  return message.slice(0, end);
}

const MAX_REFRESH_ERROR_CHAIN_DEPTH = 10;

/**
 * The matched terminal marker when a refresh failure permanently kills the
 * stored credential, `undefined` for transient failures that must not retire it.
 * Inspects the whole `cause` chain: a marker retires only alongside a terminal
 * 4xx, and a 5xx at any layer vetoes it, since a gateway failure can wrap a
 * quoted marker without the token endpoint having judged the credential.
 */
export function terminalOAuthRefreshErrorMarker(error: unknown): string | undefined {
  let marker: string | undefined;
  let terminalStatus = false;
  let serverErrorStatus = false;
  let current: unknown = error;
  for (
    let depth = 0;
    current !== undefined && current !== null && depth < MAX_REFRESH_ERROR_CHAIN_DEPTH;
    depth += 1
  ) {
    const message =
      current instanceof Error ? current.message : typeof current === "string" ? current : "";
    marker ??= TERMINAL_REFRESH_ERROR_PATTERNS.find(([, pattern]) => pattern.test(message))?.[0];
    const header = statusHeader(message);
    for (const pattern of REFRESH_ERROR_STATUS_PATTERNS) {
      for (const match of header.matchAll(pattern)) {
        const status = Number(match[1]);
        if (TERMINAL_REFRESH_HTTP_STATUSES.has(status)) terminalStatus = true;
        else if (status >= 500 && status <= 599) serverErrorStatus = true;
      }
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return marker !== undefined && terminalStatus && !serverErrorStatus ? marker : undefined;
}

const OPENAI_AUTH_CLAIMS_NAMESPACE = "https://api.openai.com/auth";

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
    return payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export const OAUTH_ACCOUNT_CHANGED_ERROR =
  "The ChatGPT account changed during sign-in refresh. Connect the provider again.";

/** Worded so `isModelCredentialRejected` moves a run to its backup model. */
export const OAUTH_RECONNECT_REQUIRED_ERROR =
  "The sign-in token expired or was revoked. Connect that model provider again.";

function nonBlankString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * `accountId`, else `chatgpt_account_id` from the access JWT. Never throws: an
 * undecodable token yields `undefined`, which disables the account-change
 * comparison instead of breaking refresh.
 */
export function oauthCredentialAccountId(credential: OAuthCredential): string | undefined {
  const direct = nonBlankString(credential.accountId);
  if (direct) return direct;
  const payload = decodeJwtPayload(credential.access);
  if (!payload) return undefined;
  const namespaced = payload[OPENAI_AUTH_CLAIMS_NAMESPACE];
  const claims =
    namespaced && typeof namespaced === "object"
      ? (namespaced as Record<string, unknown>)
      : undefined;
  return nonBlankString(claims?.chatgpt_account_id) ?? nonBlankString(payload.chatgpt_account_id);
}

/**
 * The retirement detail when a refresh returned a token for a different account than the
 * stored one. Either side without an account id disables the comparison.
 */
export function oauthAccountChange(
  stored: OAuthCredential | undefined,
  refreshed: OAuthCredential,
): string | undefined {
  const storedAccountId = stored ? oauthCredentialAccountId(stored) : undefined;
  const refreshedAccountId = oauthCredentialAccountId(refreshed);
  return storedAccountId && refreshedAccountId && storedAccountId !== refreshedAccountId
    ? `stored account ${storedAccountId}, refreshed account ${refreshedAccountId}`
    : undefined;
}

export type RetireModelCredential = (
  reason: ModelCredentialRetireReason,
  detail?: string,
  failed?: ModelCredentialFailedState,
) => Promise<boolean | undefined>;

/**
 * Retires a stored credential after a failed refresh; true only when this call retired it.
 * Retirement fences on `failed`, the stored material, so a concurrently persisted newer
 * credential survives and false means a retry may succeed. A retirement that throws is
 * logged and reported as false, leaving the credential unmarked so a later attempt can
 * retry after a database outage.
 */
export async function tryRetireModelCredential(
  retire: RetireModelCredential | undefined,
  reason: ModelCredentialRetireReason,
  detail: string,
  failed: ModelCredentialFailedState | undefined,
): Promise<boolean> {
  if (!retire) return false;
  try {
    return (await retire(reason, detail, failed)) === true;
  } catch (retireError) {
    getLogger().error("model credential retirement failed", retireError);
    return false;
  }
}

/**
 * The email an OAuth credential's access token names, for telling two signed-in accounts
 * apart. Read from the stored token only; never logged.
 */
export function oauthCredentialEmail(credential: OAuthCredential): string | undefined {
  const payload = decodeJwtPayload(credential.access);
  if (!payload) return undefined;
  const profile = payload["https://api.openai.com/profile"];
  const email =
    nonBlankString(
      profile && typeof profile === "object"
        ? (profile as Record<string, unknown>).email
        : undefined,
    ) ?? nonBlankString(payload.email);
  return email?.includes("@") ? email.trim() : undefined;
}

/** A credential was deleted before the model started. */
export class RetiredModelCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetiredModelCredentialError";
  }
}

export function isRetiredModelCredentialError(error: unknown): boolean {
  return error instanceof RetiredModelCredentialError;
}

/**
 * Stale-failure fence for `retireModelCredential`: true only while the secret row
 * still decrypts to the exact OAuth material whose refresh failed, so a row
 * rewritten by a concurrent refresh or reconnect is not deleted. Anything
 * unverifiable reports false.
 */
export function matchesFailedOAuthSecret(
  load: (ciphertext: string, secretId: string) => string | Promise<string>,
  failed: ModelCredentialFailedState,
): (secret: { id: string; ciphertext: string }) => Promise<boolean> {
  return async (secret) => {
    try {
      const stored = parseModelSecret(await load(secret.ciphertext, secret.id));
      return (
        stored.kind === "oauth" &&
        !stored.reconnectRequired &&
        stored.credential.access === failed.access &&
        stored.credential.refresh === failed.refresh &&
        stored.credential.expires === failed.expires
      );
    } catch {
      return false;
    }
  };
}

/**
 * Forwarded unvalidated so future regions work without a client update. Never
 * throws: a malformed token fails later in pi's own claim extraction.
 */
export function codexComputeResidency(accessToken: string | undefined): string | undefined {
  const record = accessToken ? decodeJwtPayload(accessToken) : undefined;
  if (!record) return undefined;
  const namespaced = record[OPENAI_AUTH_CLAIMS_NAMESPACE];
  const claim =
    (namespaced && typeof namespaced === "object"
      ? (namespaced as Record<string, unknown>).chatgpt_compute_residency
      : undefined) ?? record.chatgpt_compute_residency;
  if (typeof claim !== "string" || claim === "" || claim === "no_constraint") {
    return undefined;
  }
  return claim;
}

export function loadProviderOAuth(providerId: string): OAuthAuth | undefined {
  // pi 1.3 adds ChatGPT OAuth to OpenAI; keep subscription sign-in on Codex.
  if (providerId === "openai") return undefined;
  return providerCatalog().getProvider(canonicalPiProviderId(providerId))?.auth.oauth;
}

let cachedProviderCatalog: ReturnType<typeof builtinModels> | undefined;

function providerCatalog() {
  cachedProviderCatalog ??= builtinModels();
  return cachedProviderCatalog;
}

export type ResolveModelOpts = {
  persist?: (next: string) => Promise<void>;
  retire?: RetireModelCredential;
  now?: number;
  oauth?: Pick<OAuthAuth, "refresh" | "toAuth">;
  signal?: AbortSignal;
};

export async function resolveModelAuth(
  plaintext: string,
  provider: string,
  opts?: ResolveModelOpts,
): Promise<{ secret: Exclude<StoredModelSecret, { reconnectRequired: true }>; apiKey: string }> {
  const parsed = parseModelSecret(plaintext);
  if (parsed.kind === "api_key") return { secret: parsed, apiKey: parsed.key };
  if (parsed.kind === "openai_compatible") {
    return { secret: parsed, apiKey: parsed.apiKey ?? "" };
  }
  if (parsed.reconnectRequired) {
    throw new RetiredModelCredentialError(OAUTH_RECONNECT_REQUIRED_ERROR);
  }
  const oauth = opts?.oauth ?? loadProviderOAuth(provider);
  if (!oauth) {
    throw new Error(`No OAuth handler for ${provider}. Sign in again from onboarding.`);
  }
  const now = opts?.now ?? Date.now();
  let credential = parsed.credential;
  const kept = keptModelSettings(parsed);
  if (credential.expires - now < MIN_OAUTH_VALIDITY_MS) {
    try {
      credential = await oauth.refresh(credential, opts?.signal ?? new AbortController().signal);
    } catch (error) {
      const marker = terminalOAuthRefreshErrorMarker(error);
      // The provider error can quote response text, so a confirmed failure is reported
      // with a fixed message that contains no token material.
      if (
        marker &&
        (await tryRetireModelCredential(
          opts?.retire,
          "terminal-refresh-failure",
          marker,
          credential,
        ))
      )
        throw new RetiredModelCredentialError(OAUTH_RECONNECT_REQUIRED_ERROR);
      throw error;
    }
    // Compare before persist so a token for a different account is never stored.
    const accountChange = oauthAccountChange(parsed.credential, credential);
    if (accountChange) {
      if (
        await tryRetireModelCredential(
          opts?.retire,
          "account-changed",
          accountChange,
          parsed.credential,
        )
      )
        throw new RetiredModelCredentialError(OAUTH_ACCOUNT_CHANGED_ERROR);
      throw new Error(OAUTH_ACCOUNT_CHANGED_ERROR);
    }
    await opts?.persist?.(
      serializeModelSecret({
        kind: "oauth",
        credential,
        ...kept,
      }),
    );
  }
  const auth = await oauth.toAuth(credential);
  if (!auth.apiKey) {
    throw new Error("Subscription sign-in did not produce a usable token. Sign in again.");
  }
  return {
    secret: {
      kind: "oauth",
      credential,
      ...kept,
    },
    apiKey: auth.apiKey,
  };
}

export async function resolveModelApiKey(
  plaintext: string,
  provider: string,
  opts?: ResolveModelOpts,
): Promise<string> {
  const resolved = await resolveModelAuth(plaintext, provider, opts);
  return resolved.apiKey;
}
