import { createHash, randomBytes, scrypt } from "node:crypto";
import type { AuthInteraction, OAuthCredential } from "@earendil-works/pi-ai";
import { deadlineSignal, readResponseWithin } from "@rakazo/core";

const AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize";
const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
const REDIRECT_URI = "http://127.0.0.1:1455/auth/callback";
const RESOURCE = "https://api.openai.com/v1";
const DIRECT_SCOPE = "chatgpt.tokens.use.direct";
const SCOPE = `openid profile email offline_access resource.invoke ${DIRECT_SCOPE}`;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;

type Options = { verifier?: string; fetch?: typeof fetch };

function derivedValue(verifier: string, purpose: string): string {
  return createHash("sha256")
    .update(`rakazo:chatgpt:${purpose}:v1\0`)
    .update(verifier)
    .digest("base64url");
}

// The id appears in every sign-in link, so it comes from a slow hash: a cheap one would let
// anyone who can start a sign-in test guesses at the encryption key offline.
const HOST_ID_SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
let hostIdCache: { key: string; id: Promise<string> } | undefined;

function agentHostId(): Promise<string> {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) throw new Error("ChatGPT sign-in needs the server encryption key.");
  if (hostIdCache?.key !== key) {
    const id = new Promise<string>((resolve, reject) =>
      scrypt(key, "rakazo:agent-host:v1", 16, HOST_ID_SCRYPT, (error, bytes) => {
        if (error) return reject(error);
        bytes[6] = (bytes[6]! & 0x0f) | 0x40;
        bytes[8] = (bytes[8]! & 0x3f) | 0x80;
        const hex = bytes.toString("hex");
        resolve(
          `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
        );
      }),
    );
    hostIdCache = { key, id };
    id.catch(() => {
      if (hostIdCache?.id === id) hostIdCache = undefined;
    });
  }
  return hostIdCache.id;
}

/** The OAuth `error` code of a refused exchange (RFC 6749 §5.2), such as `invalid_grant`, when the body has one. */
async function tokenErrorCode(
  response: Response,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const bytes = await readResponseWithin(response, {
      maxBytes: MAX_TOKEN_RESPONSE_BYTES,
      tooLargeMessage: "ChatGPT token error is too large.",
      signal,
    });
    const error = (JSON.parse(new TextDecoder().decode(bytes)) as { error?: unknown }).error;
    return typeof error === "string" && /^[a-z_]{1,64}$/.test(error) ? error : undefined;
  } catch {
    return undefined;
  }
}

/** The browser callback is pasted into Rakazo; the verifier is stored for an API process hand-off. */
export function createManualOpenAIOAuthLogin(options: Options = {}) {
  const request = options.fetch ?? fetch;
  return async (interaction: AuthInteraction): Promise<OAuthCredential> => {
    const interactionSignal = interaction.signal ?? new AbortController().signal;
    const verifier = options.verifier ?? randomBytes(32).toString("base64url");
    const state = derivedValue(verifier, "state");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorization = new URL(AUTHORIZE_URL);
    authorization.search = new URLSearchParams({
      client_id: "dynamic_agent_client",
      agent_name_hint: "Rakazo",
      ext_agent_host_id: await agentHostId(),
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      resource: RESOURCE,
      scope: SCOPE,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      nonce: derivedValue(verifier, "nonce"),
    }).toString();
    interaction.notify({
      type: "auth_url",
      url: authorization.toString(),
      instructions: "Complete sign-in in your browser, then paste the full callback URL.",
    });
    const input = await interaction.prompt({
      type: "manual_code",
      message: "Paste the full callback URL from the browser:",
      placeholder: REDIRECT_URI,
      signal: interactionSignal,
    });
    let callback: URL;
    try {
      callback = new URL(input.trim());
    } catch {
      throw new Error("Paste the full callback URL from the browser.");
    }
    if (
      callback.origin !== new URL(REDIRECT_URI).origin ||
      callback.pathname !== "/auth/callback"
    ) {
      throw new Error("The pasted callback URL is not from the ChatGPT sign-in redirect.");
    }
    const failure = callback.searchParams.get("error");
    if (failure) throw new Error(`ChatGPT authorization failed: ${failure}`);
    if (callback.searchParams.get("state") !== state) throw new Error("OAuth state mismatch.");
    const code = callback.searchParams.get("code");
    const clientId = callback.searchParams.get("client_id");
    if (!code || !clientId)
      throw new Error("ChatGPT callback is missing its code or issued client ID.");

    const signal = deadlineSignal(30_000, interactionSignal);
    const response = await request(TOKEN_URL, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
        resource: RESOURCE,
      }),
      signal,
    });
    if (!response.ok) {
      const reason = await tokenErrorCode(response, signal);
      throw new Error(
        `ChatGPT token exchange failed (${response.status}${reason ? ` ${reason}` : ""}). Start sign-in again.`,
      );
    }
    const bytes = await readResponseWithin(response, {
      maxBytes: MAX_TOKEN_RESPONSE_BYTES,
      tooLargeMessage: "ChatGPT token response is too large.",
      signal,
    });
    let data: unknown;
    try {
      data = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error("ChatGPT token response is invalid.");
    }
    if (!data || typeof data !== "object") throw new Error("ChatGPT token response is invalid.");
    const token = data as Record<string, unknown>;
    // A token response may leave out scope when it grants exactly what was asked (RFC 6749 §5.1).
    const scopes = (typeof token.scope === "string" ? token.scope : SCOPE).trim().split(/\s+/);
    if (
      typeof token.access_token !== "string" ||
      !token.access_token ||
      typeof token.refresh_token !== "string" ||
      !token.refresh_token ||
      typeof token.id_token !== "string" ||
      !token.id_token ||
      typeof token.expires_in !== "number" ||
      !Number.isFinite(token.expires_in) ||
      token.expires_in <= 0 ||
      !scopes.includes(DIRECT_SCOPE)
    )
      throw new Error("ChatGPT token response is invalid or lacks direct API access.");
    return {
      type: "oauth",
      access: token.access_token,
      refresh: token.refresh_token,
      expires: Date.now() + token.expires_in * 1000 - 3 * 60 * 1000,
      clientId,
      scopes,
    };
  };
}
