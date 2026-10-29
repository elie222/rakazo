import { randomBytes, randomUUID } from "node:crypto";
import type {
  AuthInteraction,
  Credential,
  OAuthAuth,
  OAuthCredential,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type {
  ModelCredentialFailedState,
  ModelCredentialRetireReason,
  SecretStore,
} from "@rakazo/adapter-kit";
import type {
  ModelContextLimits,
  ModelOAuthBegin,
  ModelOAuthSignInMode,
  SettingsScope,
  ThinkingLevel,
} from "@rakazo/contracts";
import {
  canonicalPiProviderId,
  MAX_MODEL_CONTEXT_WINDOW,
  MAX_MODEL_MAX_TOKENS,
  ModelContextLimitsSchema,
  parseModelHeaders,
  ThinkingLevelSchema,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { retireModelCredential, runAsSystem, runAsTenant } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { createManualAnthropicOAuthLogin } from "./pi-anthropic-oauth.js";

export const CHATGPT_OAUTH_PROVIDER = "openai-codex";
export const COPILOT_OAUTH_PROVIDER = "github-copilot";
export const XAI_OAUTH_PROVIDER = "xai";
export const ANTHROPIC_OAUTH_PROVIDER = "anthropic";

export const SUBSCRIPTION_SIGN_IN_PROVIDERS: Record<
  string,
  {
    mode: ModelOAuthSignInMode;
    loginLabel: string;
    hint: string;
    billing: string;
  }
> = {
  [CHATGPT_OAUTH_PROVIDER]: {
    mode: "device-code",
    loginLabel: "Sign in with ChatGPT",
    hint: "ChatGPT Plus/Pro",
    billing:
      "Sign in with ChatGPT Plus or Pro. Uses your OpenAI subscription. Rakazo does not pay.",
  },
  [COPILOT_OAUTH_PROVIDER]: {
    mode: "device-code",
    loginLabel: "Sign in with GitHub Copilot",
    hint: "Copilot",
    billing: "Sign in with GitHub Copilot. Uses your Copilot subscription. Rakazo does not pay.",
  },
  [XAI_OAUTH_PROVIDER]: {
    mode: "device-code",
    loginLabel: "Sign in with SuperGrok or X Premium",
    hint: "SuperGrok / key",
    billing: "Sign in with SuperGrok or X Premium, or paste an xAI API key. Rakazo does not pay.",
  },
  [ANTHROPIC_OAUTH_PROVIDER]: {
    mode: "auth-url",
    loginLabel: "Sign in with Claude",
    hint: "Claude Pro/Max / key",
    // Button + "Or paste an API key" already explain the choices; no extra paragraph.
    billing: "",
  },
};

const MIN_OAUTH_VALIDITY_MS = 5 * 60 * 1000;
const SIGN_IN_START_WAIT_MS = 30_000;
/** How long a sign-in that hands back a code stays open, on any API process. */
const PASTED_CODE_TTL_SECONDS = 15 * 60;
/** Bound on a detached credential refresh so it cannot pin the shared lock. */
const REFRESH_KICK_TIMEOUT_MS = 30_000;
const CORRUPT_MODEL_SECRET_MESSAGE =
  "Stored model credential is corrupt. Connect the provider again.";

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

const retiredCredentialErrors = new WeakSet<object>();

/**
 * A credential was deleted before the model started. Account-change throws this
 * directly. A terminal refresh keeps its original provider error and is recorded
 * in `retiredCredentialErrors` so callers can still see that error object.
 */
export class RetiredModelCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetiredModelCredentialError";
  }
}

export function markRetiredModelCredentialError(error: unknown): void {
  if (typeof error === "object" && error !== null) retiredCredentialErrors.add(error);
}

export function isRetiredModelCredentialError(error: unknown): boolean {
  return (
    error instanceof RetiredModelCredentialError ||
    (typeof error === "object" && error !== null && retiredCredentialErrors.has(error))
  );
}

export type StoredModelLimits = ModelContextLimits;

function modelLimits(value: Record<string, unknown>): StoredModelLimits {
  const cache = ModelContextLimitsSchema.shape.cacheCapabilities.safeParse(value.cacheCapabilities);
  const window = ModelContextLimitsSchema.shape.contextWindow.safeParse(value.contextWindow);
  return {
    ...(cache.success && cache.data !== undefined ? { cacheCapabilities: cache.data } : {}),
    ...(window.success && window.data !== undefined ? { contextWindow: window.data } : {}),
  };
}

export type StoredModelSecret =
  | ({
      kind: "api_key";
      key: string;
      maxTokens?: number;
      accountId?: string;
      gatewayId?: string;
    } & StoredModelLimits)
  | { kind: "oauth"; reconnectRequired: true; maxTokens?: number }
  | { kind: "oauth"; reconnectRequired?: false; credential: OAuthCredential; maxTokens?: number }
  | ({
      kind: "openai_compatible";
      baseUrl: string;
      headers?: Record<string, string>;
      apiKey?: string;
      reasoning?: boolean;
      thinkingLevel?: ThinkingLevel | null;
      maxTokens?: number;
      contextWindow?: number;
      visionModelIds?: string[];
      enabledModelIds?: string[];
      maxImagesPerPrompt?: number;
    } & StoredModelLimits);

export type PiOAuthConnected = {
  status: "connected";
  credential: OAuthCredential;
  provider: string;
  /** The connection this sign-in renews; null adds one; undefined is an older app's sign-in. */
  credentialId?: string | null;
  modelId?: string;
  thinkingLevel?: string | null;
  makeDefault?: boolean;
  /** Which copy of the member's models makeDefault sets; omitted means the one that applies. */
  settingsScope?: SettingsScope;
  label?: string;
  signal: AbortSignal;
};

export type PiOAuthComplete =
  | { status: "pending" }
  | PiOAuthConnected
  /** The provider is known once a session existed, so the failure can be attributed. */
  | { status: "error"; error: string; provider?: string };

export type PiOAuthFinish<T> =
  | { status: "pending" }
  | { status: "connected"; value: T }
  | { status: "error"; error: string };

export type PiOAuthBegin = ModelOAuthBegin;

type WithoutLogin<T> = T extends unknown ? Omit<T, "loginId" | "provider"> : never;
type PiOAuthStarted = WithoutLogin<PiOAuthBegin>;

type LoginFn = (
  providerId: string,
  type: "oauth",
  interaction: AuthInteraction,
  options?: { codePage?: boolean; verifier?: string },
) => Promise<Credential>;

/** A pasted-code sign-in the user has to correct or start again. */
export class ModelSignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelSignInError";
  }
}

type SignInActor = { userId: string; spaceId: string };

type BeginInput = SignInActor & {
  provider: string;
  credentialId?: string | null;
  modelId?: string;
  thinkingLevel?: string | null;
  makeDefault?: boolean;
  settingsScope?: SettingsScope;
  label?: string;
  /** The client has no loopback listener, so the provider shows the code to paste. */
  codePage?: boolean;
  signal?: AbortSignal;
};

/** What another API process needs to finish a sign-in that hands back a code. */
type HandedOffSignIn = Omit<BeginInput, "userId" | "spaceId" | "signal"> & { verifier: string };

/** Where sign-ins that hand back a code are kept, encrypted, so a deploy or another API
 *  process receiving the code does not lose them. Without it they live in this process only. */
export type PiOAuthHandoffStore = {
  prisma: Pick<PrismaClient, "modelOAuthSession">;
  secrets: Pick<SecretStore, "put" | "load">;
};

type SessionState = "pending" | "ready" | "finalizing" | "consumed";

type Session = {
  id: string;
  scope: string;
  userId: string;
  spaceId: string;
  provider: string;
  credentialId?: string | null;
  modelId?: string;
  thinkingLevel?: string | null;
  makeDefault?: boolean;
  settingsScope?: SettingsScope;
  label?: string;
  abort: AbortController;
  state: SessionState;
  credential?: OAuthCredential;
  error?: string;
  finishing?: Promise<void>;
  // auth-url flows: resolves the runtime's "paste the redirect URL" prompt.
  submitCode?: (input: string) => void;
  codeSubmitted?: boolean;
  /** A stored hand-off row may exist for this sign-in. */
  handedOff?: boolean;
  expiresTimer?: ReturnType<typeof setTimeout>;
  /** The expiry timer fired while finish() was still persisting. */
  expired?: boolean;
};

function isOAuthCredential(value: Credential): value is OAuthCredential {
  return value.type === "oauth";
}

function readOAuthCredential(value: unknown): OAuthCredential | undefined {
  if (!value || typeof value !== "object") return undefined;
  const parsed = value as Record<string, unknown>;
  if (
    parsed.type === "oauth" &&
    typeof parsed.access === "string" &&
    typeof parsed.refresh === "string" &&
    typeof parsed.expires === "number"
  ) {
    return parsed as OAuthCredential;
  }
  return undefined;
}

function parsedRoutingId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parsedMaxTokens(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_MODEL_MAX_TOKENS
    ? value
    : undefined;
}

function parsedModelIds(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter(
        (modelId): modelId is string => typeof modelId === "string" && modelId.trim().length > 0,
      )
    : undefined;
}

export function parseModelSecret(plaintext: string): StoredModelSecret {
  const trimmed = plaintext.trim();
  if (!trimmed.startsWith("{")) return { kind: "api_key", key: plaintext };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    // Treat malformed JSON as a literal API key.
    return { kind: "api_key", key: plaintext };
  }
  if (parsed.kind === "openai_compatible") {
    if (typeof parsed.baseUrl !== "string" || !parsed.baseUrl.trim()) {
      throw new Error(CORRUPT_MODEL_SECRET_MESSAGE);
    }
    const headers = parsed.headers === undefined ? undefined : parseModelHeaders(parsed.headers);
    const apiKey = typeof parsed.apiKey === "string" ? parsed.apiKey : undefined;
    const parsedThinkingLevel = ThinkingLevelSchema.nullable().safeParse(parsed.thinkingLevel);
    const thinkingLevel = parsedThinkingLevel.success ? parsedThinkingLevel.data : undefined;
    const maxTokens = parsedMaxTokens(parsed.maxTokens);
    const contextWindow =
      typeof parsed.contextWindow === "number" &&
      Number.isInteger(parsed.contextWindow) &&
      parsed.contextWindow >= 1 &&
      parsed.contextWindow <= MAX_MODEL_CONTEXT_WINDOW
        ? parsed.contextWindow
        : undefined;
    const visionModelIds = parsedModelIds(parsed.visionModelIds);
    const enabledModelIds = parsedModelIds(parsed.enabledModelIds);
    const maxImagesPerPrompt =
      typeof parsed.maxImagesPerPrompt === "number" &&
      Number.isInteger(parsed.maxImagesPerPrompt) &&
      parsed.maxImagesPerPrompt >= 1 &&
      parsed.maxImagesPerPrompt <= 1000
        ? parsed.maxImagesPerPrompt
        : undefined;
    return {
      kind: "openai_compatible",
      baseUrl: parsed.baseUrl.trim(),
      ...(headers !== undefined ? { headers } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(typeof parsed.reasoning === "boolean" ? { reasoning: parsed.reasoning } : {}),
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(visionModelIds ? { visionModelIds } : {}),
      ...(enabledModelIds ? { enabledModelIds } : {}),
      ...(maxImagesPerPrompt !== undefined ? { maxImagesPerPrompt } : {}),
      ...modelLimits(parsed),
    };
  }
  if (parsed.kind === "api_key") {
    if (typeof parsed.key !== "string" || !parsed.key) {
      throw new Error(CORRUPT_MODEL_SECRET_MESSAGE);
    }
    const maxTokens = parsedMaxTokens(parsed.maxTokens);
    const accountId = parsedRoutingId(parsed.accountId);
    const gatewayId = parsedRoutingId(parsed.gatewayId);
    return {
      kind: "api_key",
      key: parsed.key,
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(accountId ? { accountId } : {}),
      ...(gatewayId ? { gatewayId } : {}),
      ...modelLimits(parsed),
    };
  }
  if (parsed.kind === "oauth") {
    const maxTokens = parsedMaxTokens(parsed.maxTokens);
    if (parsed.reconnectRequired === true) {
      return {
        kind: "oauth",
        reconnectRequired: true,
        ...(maxTokens !== undefined ? { maxTokens } : {}),
      };
    }
    const credential = readOAuthCredential(parsed.credential);
    if (!credential) throw new Error(CORRUPT_MODEL_SECRET_MESSAGE);
    return {
      kind: "oauth",
      credential,
      ...(maxTokens !== undefined ? { maxTokens } : {}),
    };
  }
  // Legacy secrets serialize the bare OAuth credential without a kind wrapper.
  if (parsed.type === "oauth") {
    const credential = readOAuthCredential(parsed);
    if (!credential) throw new Error(CORRUPT_MODEL_SECRET_MESSAGE);
    return { kind: "oauth", credential };
  }
  return { kind: "api_key", key: plaintext };
}

export function serializeModelSecret(secret: StoredModelSecret): string {
  if (secret.kind === "oauth") {
    if (secret.reconnectRequired) return JSON.stringify(secret);
    if (secret.maxTokens === undefined) return JSON.stringify(secret.credential);
    return JSON.stringify({
      kind: "oauth",
      credential: secret.credential,
      maxTokens: secret.maxTokens,
    });
  }
  if (secret.kind === "openai_compatible") {
    return JSON.stringify({
      kind: "openai_compatible",
      ...modelLimits(secret as unknown as Record<string, unknown>),
      baseUrl: secret.baseUrl,
      ...(secret.headers !== undefined ? { headers: parseModelHeaders(secret.headers) } : {}),
      ...(secret.apiKey ? { apiKey: secret.apiKey } : {}),
      ...(secret.reasoning !== undefined ? { reasoning: secret.reasoning } : {}),
      ...(secret.thinkingLevel !== undefined ? { thinkingLevel: secret.thinkingLevel } : {}),
      ...(secret.maxTokens !== undefined ? { maxTokens: secret.maxTokens } : {}),
      ...(secret.contextWindow !== undefined ? { contextWindow: secret.contextWindow } : {}),
      ...(secret.visionModelIds !== undefined ? { visionModelIds: secret.visionModelIds } : {}),
      ...(secret.enabledModelIds !== undefined ? { enabledModelIds: secret.enabledModelIds } : {}),
      ...(secret.maxImagesPerPrompt !== undefined
        ? { maxImagesPerPrompt: secret.maxImagesPerPrompt }
        : {}),
    });
  }
  if (
    secret.maxTokens === undefined &&
    secret.accountId === undefined &&
    secret.gatewayId === undefined &&
    secret.contextWindow === undefined &&
    secret.cacheCapabilities === undefined
  ) {
    return secret.key;
  }
  return JSON.stringify({
    kind: "api_key",
    key: secret.key,
    ...(secret.maxTokens !== undefined ? { maxTokens: secret.maxTokens } : {}),
    ...(secret.accountId ? { accountId: secret.accountId } : {}),
    ...(secret.gatewayId ? { gatewayId: secret.gatewayId } : {}),
    ...modelLimits(secret as unknown as Record<string, unknown>),
  });
}

const MIN_REDACTED_HEADER_VALUE_LENGTH = 8;

export function secretValuesToRedact(secret: StoredModelSecret): string[] {
  if (secret.kind === "api_key") return secret.key ? [secret.key] : [];
  if (secret.kind === "openai_compatible")
    return [
      secret.apiKey,
      ...Object.values(secret.headers ?? {}).filter(
        (value) => value.length >= MIN_REDACTED_HEADER_VALUE_LENGTH,
      ),
    ].filter((value): value is string => Boolean(value));
  if (secret.reconnectRequired) return [];
  return [secret.credential.access, secret.credential.refresh].filter(Boolean);
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

type ResolveModelOpts = {
  persist?: (next: string) => Promise<void>;
  retire?: (
    reason: ModelCredentialRetireReason,
    detail?: string,
    failed?: ModelCredentialFailedState,
  ) => Promise<boolean | undefined>;
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
  const maxTokens = parsed.maxTokens;
  if (credential.expires - now < MIN_OAUTH_VALIDITY_MS) {
    try {
      credential = await oauth.refresh(credential, opts?.signal ?? new AbortController().signal);
    } catch (error) {
      const marker = terminalOAuthRefreshErrorMarker(error);
      if (marker && opts?.retire) {
        let deleted = false;
        try {
          // Retirement fences on the stored material so a concurrently persisted
          // newer credential survives the delete.
          deleted = (await opts.retire("terminal-refresh-failure", marker, credential)) === true;
        } catch (retireError) {
          // Leave the error unmarked so setup can retry after a database outage.
          getLogger().error("model credential retirement failed", retireError);
          throw error;
        }
        // A skipped replacement means a newer credential won the race and a retry may succeed.
        // The provider error can quote response text, so a confirmed failure is reported
        // with a fixed message that contains no token material.
        if (deleted) throw new RetiredModelCredentialError(OAUTH_RECONNECT_REQUIRED_ERROR);
      }
      throw error;
    }
    // Compare before persist so a token for a different account is never stored.
    // Either side without an account id disables the comparison.
    const storedAccountId = oauthCredentialAccountId(parsed.credential);
    const refreshedAccountId = oauthCredentialAccountId(credential);
    if (storedAccountId && refreshedAccountId && storedAccountId !== refreshedAccountId) {
      let deleted = false;
      if (opts?.retire) {
        try {
          // Retirement fences on the stored material so a concurrently persisted
          // newer credential survives the delete.
          deleted =
            (await opts.retire(
              "account-changed",
              `stored account ${storedAccountId}, refreshed account ${refreshedAccountId}`,
              parsed.credential,
            )) === true;
        } catch (retireError) {
          // Leave it unmarked so setup can retry after a database outage.
          getLogger().error("model credential retirement failed", retireError);
        }
      }
      // A skipped delete means a newer credential survived and a retry may succeed.
      if (deleted) throw new RetiredModelCredentialError(OAUTH_ACCOUNT_CHANGED_ERROR);
      throw new Error(OAUTH_ACCOUNT_CHANGED_ERROR);
    }
    await opts?.persist?.(
      serializeModelSecret({
        kind: "oauth",
        credential,
        ...(maxTokens !== undefined ? { maxTokens } : {}),
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
      ...(maxTokens !== undefined ? { maxTokens } : {}),
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

const modelCredentialLocks = new Map<string, Promise<void>>();

/** Concurrent runs and refresh kicks must not double-refresh or clobber each other's token write. */
export async function withModelCredentialLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = modelCredentialLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = previous.then(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  modelCredentialLocks.set(key, current);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (modelCredentialLocks.get(key) === current) modelCredentialLocks.delete(key);
  }
}

/**
 * Retire callback for `resolveModelAuth`. `retireModelCredential` fences against
 * newer material; a confirmed failure swaps the rejected tokens for a reconnect
 * marker that keeps the connection's settings. Whichever stored copy ends up
 * unreferenced is deleted.
 */
export function retireToReconnectMarker(
  prisma: Pick<PrismaClient, "$transaction" | "secret">,
  secretStore: Pick<SecretStore, "put" | "load" | "delete">,
  scope: { userId: string; spaceId: string },
  credential: { id: string; secretId: string },
  maxTokens: number | undefined,
) {
  return async (
    _reason: ModelCredentialRetireReason,
    _detail: string | undefined,
    failed?: ModelCredentialFailedState,
  ): Promise<boolean> => {
    const previous = (
      await prisma.secret.findFirst({
        where: { id: credential.secretId, userId: scope.userId, spaceId: null },
        select: { ciphertext: true },
      })
    )?.ciphertext;
    const replacement = await secretStore.put(
      serializeModelSecret({
        kind: "oauth",
        reconnectRequired: true,
        ...(maxTokens !== undefined ? { maxTokens } : {}),
      }),
      {
        operationId: "cred",
        traceId: "cred-reconnect",
        spaceId: scope.spaceId,
        userId: scope.userId,
        signal: new AbortController().signal,
      },
      { recordId: credential.secretId },
    );
    let replaced = false;
    try {
      const retired = await retireModelCredential(prisma, {
        userId: scope.userId,
        credentialId: credential.id,
        secretId: credential.secretId,
        replacementCiphertext: replacement.ciphertext,
        matchesFailedSecret: failed
          ? matchesFailedOAuthSecret(
              (ciphertext, secretId) => secretStore.load(ciphertext, secretId),
              failed,
            )
          : undefined,
      });
      replaced = retired && previous !== undefined;
      return retired;
    } finally {
      const unused = replaced ? previous : replacement.ciphertext;
      if (unused) await secretStore.delete(unused, credential.secretId).catch(() => undefined);
    }
  };
}

/** The only token writer, shared by the run path and the detached refresh kick. */
export function persistStoredModelSecret(
  prisma: Pick<PrismaClient, "secret">,
  secretStore: Pick<SecretStore, "put">,
  scope: { userId: string; spaceId: string },
  secretId: string,
): (next: string) => Promise<void> {
  return async (next) => {
    const stored = await secretStore.put(
      next,
      {
        operationId: "cred",
        traceId: "cred-refresh",
        spaceId: scope.spaceId,
        userId: scope.userId,
        signal: new AbortController().signal,
      },
      { recordId: secretId },
    );
    await prisma.secret.update({
      where: { id: secretId },
      data: { ciphertext: stored.ciphertext },
    });
  };
}

/**
 * `resolveModelAuth` refreshes only a near-expiry credential, so a kick queued
 * behind a run's own refresh is a no-op once the stored token is fresh.
 */
export async function refreshExpiredModelCredential(
  prisma: Pick<PrismaClient, "secret">,
  secretStore: Pick<SecretStore, "load" | "put">,
  scope: { userId: string; spaceId: string },
  secretId: string,
  provider: string,
  opts?: Pick<ResolveModelOpts, "oauth" | "signal" | "now">,
): Promise<void> {
  await withModelCredentialLock(secretId, async () => {
    const row = await prisma.secret.findFirst({
      where: { id: secretId, userId: scope.userId, spaceId: null },
      select: { id: true, ciphertext: true },
    });
    if (!row) return;
    let plaintext: string;
    try {
      plaintext = await secretStore.load(row.ciphertext, row.id);
      const parsed = parseModelSecret(plaintext);
      if (parsed.kind !== "oauth" || parsed.reconnectRequired) return;
    } catch {
      return;
    }
    await resolveModelAuth(plaintext, provider, {
      ...opts,
      persist: persistStoredModelSecret(prisma, secretStore, scope, row.id),
    });
  });
}

const credentialRefreshKicks = new Map<string, Promise<void>>();

/** Concurrent kicks for one credential collapse into a single refresh. */
export function kickModelCredentialRefresh(
  prisma: Pick<PrismaClient, "secret">,
  secretStore: Pick<SecretStore, "load" | "put">,
  scope: { userId: string; spaceId: string },
  secretId: string,
  provider: string,
  opts?: Pick<ResolveModelOpts, "oauth" | "signal" | "now">,
): void {
  if (credentialRefreshKicks.has(secretId)) return;
  const kick = refreshExpiredModelCredential(prisma, secretStore, scope, secretId, provider, {
    signal: opts?.signal ?? AbortSignal.timeout(REFRESH_KICK_TIMEOUT_MS),
    ...(opts?.oauth ? { oauth: opts.oauth } : {}),
    ...(opts?.now !== undefined ? { now: opts.now } : {}),
  })
    .catch(() => undefined)
    .finally(() => {
      if (credentialRefreshKicks.get(secretId) === kick) {
        credentialRefreshKicks.delete(secretId);
      }
    });
  credentialRefreshKicks.set(secretId, kick);
}

export class PiOAuthLogins {
  private readonly pending = new Map<string, Session>();
  private readonly activeByScope = new Map<string, Session>();
  private readonly replacementTails = new Map<string, Promise<void>>();

  constructor(
    private readonly loginFn: LoginFn = defaultLogin,
    private readonly handoff?: PiOAuthHandoffStore,
  ) {}

  async begin(input: BeginInput): Promise<PiOAuthBegin> {
    // The pasted code can reach another API process (a deploy replaces this one), which
    // then needs this verifier to exchange it.
    const verifier =
      this.handoff && SUBSCRIPTION_SIGN_IN_PROVIDERS[input.provider]?.mode === "auth-url"
        ? randomBytes(32).toString("base64url")
        : undefined;
    const started = await this.start(input, randomUUID(), verifier);
    if (verifier && started.mode === "auth-url") {
      await this.handOff(started.loginId, input, verifier);
    }
    return started;
  }

  private async start(
    input: BeginInput,
    loginId: string,
    verifier: string | undefined,
  ): Promise<PiOAuthBegin> {
    if (!SUBSCRIPTION_SIGN_IN_PROVIDERS[input.provider]) {
      throw new Error(
        "In-app subscription sign-in is only available for ChatGPT Plus/Pro, Claude Pro/Max, GitHub Copilot, and SuperGrok.",
      );
    }
    if (input.signal?.aborted) {
      throw input.signal.reason ?? new Error("Sign-in cancelled.");
    }

    const scope = oauthScopeKey(input.userId, input.spaceId, input.provider, input.credentialId);
    const lockKey = oauthProviderKey(input.userId, input.provider);
    const prepared = await this.withReplacementLock(lockKey, input.signal, async () => {
      await this.retireActiveSession(scope, input.signal);
      throwIfAborted(input.signal);

      const abort = new AbortController();
      const abortFromRequest = () => abort.abort(input.signal?.reason);
      const session: Session = {
        id: loginId,
        scope,
        userId: input.userId,
        spaceId: input.spaceId,
        provider: input.provider,
        credentialId: input.credentialId,
        modelId: input.modelId,
        thinkingLevel: input.thinkingLevel,
        makeDefault: input.makeDefault,
        settingsScope: input.settingsScope,
        label: input.label,
        abort,
        state: "pending",
        handedOff: verifier !== undefined,
      };

      const signInStarted = deferred<PiOAuthStarted>();

      const done = this.loginFn(
        input.provider,
        "oauth",
        {
          signal: abort.signal,
          async prompt(prompt) {
            if (prompt.type === "select") {
              const option = prompt.options.find((entry) => entry.id === "device_code");
              if (!option) {
                throw new Error("Device-code sign-in is not available for this provider.");
              }
              return option.id;
            }
            if (prompt.type === "manual_code") {
              return new Promise<string>((resolve, reject) => {
                const signals = [abort.signal, prompt.signal].filter(
                  (signal): signal is AbortSignal => signal !== undefined,
                );
                const removeAbortListeners = () => {
                  for (const signal of signals) signal.removeEventListener("abort", onAbort);
                };
                const onAbort = (event: Event) => {
                  removeAbortListeners();
                  session.submitCode = undefined;
                  const signal = event.currentTarget as AbortSignal;
                  reject(signal.reason ?? new Error("Sign-in cancelled."));
                };
                session.submitCode = (code) => {
                  removeAbortListeners();
                  session.submitCode = undefined;
                  resolve(code);
                };
                const aborted = signals.find((signal) => signal.aborted);
                if (aborted) {
                  removeAbortListeners();
                  session.submitCode = undefined;
                  reject(aborted.reason ?? new Error("Sign-in cancelled."));
                } else {
                  for (const signal of signals)
                    signal.addEventListener("abort", onAbort, { once: true });
                }
              });
            }
            // Copilot asks for a GitHub Enterprise host first. Blank is github.com.
            if (prompt.type === "text") return "";
            throw new Error("Unexpected subscription login prompt.");
          },
          notify(event) {
            if (event.type === "device_code") {
              signInStarted.resolve({
                mode: "device-code",
                userCode: event.userCode,
                verificationUri: httpsAuthorizationUrl(event.verificationUri),
                expiresInSeconds: event.expiresInSeconds ?? 15 * 60,
              });
            }
            if (event.type === "auth_url") {
              signInStarted.resolve({
                mode: "auth-url",
                verificationUri: httpsAuthorizationUrl(event.url),
                expiresInSeconds: PASTED_CODE_TTL_SECONDS,
              });
            }
          },
        },
        { codePage: input.codePage, verifier },
      )
        .then((credential) => {
          if (!isOAuthCredential(credential)) {
            throw new Error("Subscription sign-in did not return an OAuth credential.");
          }
          session.credential = credential;
          session.state = "ready";
          return credential;
        })
        .catch((error) => {
          session.error = error instanceof Error ? error.message : "Subscription sign-in failed.";
          signInStarted.reject(error instanceof Error ? error : new Error(session.error));
          throw error;
        });

      if (input.signal?.aborted) abortFromRequest();
      else
        input.signal?.addEventListener("abort", abortFromRequest, {
          once: true,
        });
      void done.catch(() => undefined);
      this.pending.set(loginId, session);
      this.activeByScope.set(scope, session);
      return {
        abort,
        abortFromRequest,
        signInStarted: signInStarted.promise,
        session,
      };
    });

    const { abort, abortFromRequest, signInStarted, session } = prepared;

    try {
      const started = await Promise.race([
        signInStarted,
        sleep(SIGN_IN_START_WAIT_MS).then(() => {
          throw new Error("Subscription sign-in did not start. Try again.");
        }),
      ]);
      input.signal?.removeEventListener("abort", abortFromRequest);
      if (abort.signal.aborted) throw abort.signal.reason ?? new Error("Sign-in cancelled.");
      session.expiresTimer = setTimeout(() => {
        // Removing a finalizing session would free the scope for a replacement login
        // whose credential the in-flight persist could overwrite. Remember the expiry
        // so a failed save is dropped instead of becoming a ready session with no timer.
        if (session.state === "finalizing") {
          session.expired = true;
          return;
        }
        session.abort.abort(new Error("Sign-in expired."));
        this.removeSession(session);
      }, started.expiresInSeconds * 1000);
      session.expiresTimer.unref?.();
      return {
        loginId,
        provider: input.provider,
        ...started,
      };
    } catch (error) {
      input.signal?.removeEventListener("abort", abortFromRequest);
      abort.abort();
      this.removeSession(session);
      throw error;
    }
  }

  async submit(loginId: string, actor: SignInActor, code: string): Promise<{ ok: true }> {
    const normalizedCode = code.trim();
    let session = this.pending.get(loginId);
    if (session && (session.userId !== actor.userId || session.spaceId !== actor.spaceId)) {
      session = undefined;
    }
    if (!session && normalizedCode) session = await this.resume(loginId, actor);
    if (!session) throw new ModelSignInError("Sign-in session not found. Start sign-in again.");
    if (session.error) throw new ModelSignInError(session.error);
    if (!normalizedCode) throw new ModelSignInError("Paste an authorization code or callback URL.");
    const resolve = session.submitCode;
    if (session.codeSubmitted) return { ok: true };
    if (!resolve) {
      throw new ModelSignInError("This sign-in is not waiting for a pasted code.");
    }
    session.codeSubmitted = true;
    // The code is in: no other process may resume this sign-in with the stored verifier.
    if (session.handedOff) await this.forgetHandoff(session);
    resolve(normalizedCode);
    return { ok: true };
  }

  /** Persist a sign-in waiting for its code, encrypted and bound to the member. */
  private async handOff(loginId: string, input: BeginInput, verifier: string): Promise<void> {
    const handoff = this.handoff;
    if (!handoff) return;
    const actor = { userId: input.userId, spaceId: input.spaceId };
    const stored: HandedOffSignIn = {
      provider: input.provider,
      credentialId: input.credentialId,
      modelId: input.modelId,
      thinkingLevel: input.thinkingLevel,
      makeDefault: input.makeDefault,
      settingsScope: input.settingsScope,
      label: input.label,
      codePage: input.codePage,
      verifier,
    };
    try {
      await runAsSystem("expire abandoned model sign-ins in every Space", () =>
        handoff.prisma.modelOAuthSession.deleteMany({
          where: { createdAt: { lt: new Date(Date.now() - PASTED_CODE_TTL_SECONDS * 1000) } },
        }),
      );
      const sealed = await handoff.secrets.put(
        JSON.stringify(stored),
        {
          operationId: "model.oauth.session",
          traceId: "model.oauth.session",
          ...actor,
          signal: new AbortController().signal,
        },
        { recordId: loginId, ephemeral: true },
      );
      const scope = oauthScopeKey(input.userId, input.spaceId, input.provider, input.credentialId);
      await runAsTenant(actor, async () => {
        const created = await handoff.prisma.modelOAuthSession.create({
          data: {
            id: loginId,
            ...actor,
            provider: input.provider,
            scope,
            ciphertext: sealed.ciphertext,
          },
          select: { createdAt: true },
        });
        // This sign-in replaces older ones for the same connection left open elsewhere, so
        // an older code cannot come back and retire it. A newer one is never touched.
        await handoff.prisma.modelOAuthSession.deleteMany({
          where: { ...actor, scope, createdAt: { lt: created.createdAt } },
        });
      });
    } catch (error) {
      // This process can still finish the sign-in; only another process could not.
      getLogger().error("model sign-in hand-off failed", error);
    }
    // Cancelled, replaced or disconnected while saving: no process may resume it.
    if (this.pending.get(loginId)?.state !== "pending") {
      await this.forgetHandoff({ id: loginId, ...actor });
    }
  }

  /** Take over a sign-in another API process started, once, within its lifetime. */
  private async resume(
    loginId: string,
    { userId, spaceId }: SignInActor,
  ): Promise<Session | undefined> {
    const handoff = this.handoff;
    if (!handoff) return undefined;
    const actor = { userId, spaceId };
    const row = await runAsTenant(actor, () =>
      handoff.prisma.modelOAuthSession.findFirst({
        where: {
          id: loginId,
          ...actor,
          createdAt: { gte: new Date(Date.now() - PASTED_CODE_TTL_SECONDS * 1000) },
        },
        select: { ciphertext: true },
      }),
    );
    if (!row) return undefined;
    if ((await this.forgetHandoff({ id: loginId, ...actor })) !== 1) return undefined;
    let stored: HandedOffSignIn;
    try {
      stored = JSON.parse(await handoff.secrets.load(row.ciphertext, loginId)) as HandedOffSignIn;
    } catch (error) {
      getLogger().error("model sign-in hand-off unreadable", error);
      return undefined;
    }
    if (typeof stored.verifier !== "string" || typeof stored.provider !== "string") {
      return undefined;
    }
    const { verifier, ...input } = stored;
    await this.start({ ...input, ...actor }, loginId, verifier);
    return this.pending.get(loginId);
  }

  /** Delete a stored hand-off; resolves to how many rows went, 0 when it could not. */
  private async forgetHandoff(session: Pick<Session, "id" | "userId" | "spaceId">) {
    const handoff = this.handoff;
    if (!handoff) return 0;
    const actor = { userId: session.userId, spaceId: session.spaceId };
    try {
      const deleted = await runAsTenant(actor, () =>
        handoff.prisma.modelOAuthSession.deleteMany({ where: { id: session.id, ...actor } }),
      );
      return deleted.count;
    } catch (error) {
      getLogger().error("model sign-in hand-off not deleted", error);
      return 0;
    }
  }

  complete(loginId: string, actor: { userId: string; spaceId: string }): PiOAuthComplete {
    const session = this.pending.get(loginId);
    if (!session || session.userId !== actor.userId || session.spaceId !== actor.spaceId) {
      return {
        status: "error",
        error: "Sign-in session not found. Start sign-in again.",
      };
    }
    if (session.error) {
      this.removeSession(session);
      return { status: "error", error: session.error, provider: session.provider };
    }
    if (session.state === "finalizing") return { status: "pending" };
    if (session.credential) {
      return {
        status: "connected",
        credential: session.credential,
        provider: session.provider,
        credentialId: session.credentialId,
        modelId: session.modelId,
        thinkingLevel: session.thinkingLevel,
        makeDefault: session.makeDefault,
        settingsScope: session.settingsScope,
        label: session.label,
        signal: session.abort.signal,
      };
    }
    return { status: "pending" };
  }

  async finish<T>(
    loginId: string,
    actor: { userId: string; spaceId: string },
    persist: (result: PiOAuthConnected) => Promise<T>,
  ): Promise<PiOAuthFinish<T>> {
    const session = this.pending.get(loginId);
    if (!session || session.userId !== actor.userId || session.spaceId !== actor.spaceId) {
      return {
        status: "error",
        error: "Sign-in session not found. Start sign-in again.",
      };
    }
    if (session.state === "finalizing") return { status: "pending" };
    const result = this.complete(loginId, actor);
    if (result.status !== "connected") return result;

    // The state transition is synchronous, so cancel either wins before this claim or waits
    // on `finishing` instead of aborting the write. Teardown aborts the session signal only
    // after the write settles.
    const finishing = deferred<void>();
    session.finishing = finishing.promise;
    session.state = "finalizing";
    try {
      const value = await persist({ ...result, signal: session.abort.signal });
      session.state = "consumed";
      this.removeSession(session);
      session.abort.abort();
      return { status: "connected", value };
    } catch (error) {
      if (this.pending.get(loginId) === session) {
        if (session.expired) {
          session.abort.abort(new Error("Sign-in expired."));
          this.removeSession(session);
        } else {
          session.state = "ready";
        }
      }
      throw error;
    } finally {
      if (this.pending.get(loginId) === session) session.finishing = undefined;
      finishing.resolve(undefined);
    }
  }

  async cancel(loginId: string, actor: { userId: string; spaceId: string }): Promise<void> {
    while (true) {
      const session = this.pending.get(loginId);
      if (!session || session.userId !== actor.userId || session.spaceId !== actor.spaceId) {
        // Another process may have started it: no process may resume it now.
        await this.forgetHandoff({ id: loginId, ...actor });
        return;
      }
      if (session.state === "finalizing") {
        if (session.finishing) await session.finishing;
        else return;
        continue;
      }
      if (session.state === "consumed") return;
      session.abort.abort(new Error("Sign-in cancelled."));
      this.removeSession(session);
      return;
    }
  }

  private async withReplacementLock<T>(
    scope: string,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.replacementTails.get(scope) ?? Promise.resolve();
    const release = deferred<void>();
    const current = previous.then(() => release.promise);
    this.replacementTails.set(scope, current);

    try {
      await previous;
      throwIfAborted(signal);
      return await operation();
    } finally {
      release.resolve(undefined);
      if (this.replacementTails.get(scope) === current) this.replacementTails.delete(scope);
    }
  }

  private async retireActiveSession(scope: string, signal: AbortSignal | undefined): Promise<void> {
    while (true) {
      throwIfAborted(signal);
      const session = this.activeByScope.get(scope);
      if (!session) return;
      if (session.state === "finalizing") {
        if (!session.finishing) {
          throw new Error("OAuth session is finalizing without a completion promise.");
        }
        await session.finishing;
        throwIfAborted(signal);
        continue;
      }
      if (session.state === "consumed") {
        this.removeSession(session);
        continue;
      }
      session.abort.abort(new Error("Sign-in replaced."));
      this.removeSession(session);
      return;
    }
  }

  /** Retire every sign-in this user started for one provider, in any space —
   *  disconnect removes the account credential, so no space's session may
   *  finish afterward. With `credentialId`, only sign-ins that may renew that
   *  connection are retired; a sign-in adding another account carries on. The shared provider
   *  lock orders this against begin. */
  async cancelProvider(input: {
    userId: string;
    provider: string;
    credentialId?: string;
  }): Promise<void> {
    await this.withReplacementLock(
      oauthProviderKey(input.userId, input.provider),
      undefined,
      async () => {
        const scopes = [
          ...new Set(
            [...this.pending.values()]
              .filter(
                (session) =>
                  session.userId === input.userId &&
                  session.provider === input.provider &&
                  (!input.credentialId ||
                    session.credentialId === input.credentialId ||
                    // A sign-in that never named its connection may renew this one.
                    session.credentialId === undefined),
              )
              .map((session) => session.scope),
          ),
        ];
        for (const scope of scopes) {
          await this.retireActiveSession(scope, undefined);
        }
        // A hand-off's connection is sealed in its ciphertext, so retire all of the provider's.
        const handoff = this.handoff;
        if (handoff) {
          await runAsSystem("retire a disconnected provider's sign-ins in every Space", () =>
            handoff.prisma.modelOAuthSession.deleteMany({
              where: { userId: input.userId, provider: input.provider },
            }),
          );
        }
      },
    );
  }

  private removeSession(session: Session): void {
    this.detachSession(session);
    if (session.handedOff) void this.forgetHandoff(session);
  }

  private detachSession(session: Session): void {
    if (session.expiresTimer) clearTimeout(session.expiresTimer);
    session.expiresTimer = undefined;
    if (this.pending.get(session.id) === session) this.pending.delete(session.id);
    if (this.activeByScope.get(session.scope) === session) {
      this.activeByScope.delete(session.scope);
    }
  }

  /** Shutdown: stored hand-offs stay so the next API process can finish them. */
  abortAll(): void {
    for (const session of [...this.pending.values()]) {
      this.detachSession(session);
      session.abort.abort();
    }
    this.pending.clear();
    this.activeByScope.clear();
  }
}

function defaultLogin(
  providerId: string,
  type: "oauth",
  interaction: AuthInteraction,
  options: { codePage?: boolean; verifier?: string } = {},
): Promise<Credential> {
  if (providerId === ANTHROPIC_OAUTH_PROVIDER) {
    const { verifier } = options;
    return createManualAnthropicOAuthLogin({
      codePage: options.codePage,
      ...(verifier ? { createVerifier: () => verifier } : {}),
    })(interaction);
  }
  return builtinModels().login(providerId, type, interaction);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A new sign-in replaces a pending one for the same connection, or for a new connection. */
function oauthScopeKey(
  userId: string,
  spaceId: string,
  provider: string,
  credentialId?: string | null,
): string {
  return JSON.stringify([userId, spaceId, provider, credentialId ?? null]);
}

// Begins and disconnect cancellation share one lock per user+provider so a
// mid-flight begin cannot install a session after disconnect retires them.
function oauthProviderKey(userId: string, provider: string): string {
  return JSON.stringify([userId, provider]);
}

function httpsAuthorizationUrl(input: string): string {
  const url = new URL(input);
  if (url.protocol !== "https:") throw new Error("Authorization URL must use HTTPS.");
  return url.toString();
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Sign-in cancelled.");
}
