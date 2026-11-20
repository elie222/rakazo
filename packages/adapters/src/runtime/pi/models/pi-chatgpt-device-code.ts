import type { AuthInteraction, OAuthCredential } from "@earendil-works/pi-ai";
import {
  cancelResponseBody,
  deadlineSignal,
  isRetryableError,
  pollUntil,
  readBoundedJsonResponse,
  retry,
} from "@rakazo/core";
import { getLogger } from "@rakazo/logging";

const AUTH_BASE_URL = "https://auth.openai.com";
const USER_CODE_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/token`;
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
const VERIFICATION_URI = `${AUTH_BASE_URL}/codex/device`;
const DEVICE_REDIRECT_URI = `${AUTH_BASE_URL}/deviceauth/callback`;
const ACCOUNT_CLAIM = "https://api.openai.com/auth";
// Public OAuth client identifier used by the Codex CLI. This is not a client secret.
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

/** How long the provider keeps a device code open. */
export const CHATGPT_DEVICE_CODE_TTL_SECONDS = 15 * 60;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_INTERVAL_MS = 5_000;
const MIN_INTERVAL_MS = 1_000;
// RFC 8628 section 3.5: `slow_down` adds five seconds to the interval.
const SLOW_DOWN_STEP_MS = 5_000;
const REQUEST_ATTEMPTS = 3;

/** A sign-in request the provider answered with an error status. The body stays out. */
export class SignInHttpError extends Error {
  constructor(
    step: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(`Device sign-in ${step} failed (status ${status}).`);
    this.name = "SignInHttpError";
  }
}

/** The provider could not be reached, or did not answer in time. */
class SignInNetworkError extends Error {
  constructor(step: string, options: { cause: unknown }) {
    super(`Device sign-in ${step} could not reach the provider.`, options);
    this.name = "SignInNetworkError";
  }
}

/** A blip the provider asks the client to ride out: 5xx, 408, 429, a dropped connection, or
 *  its 400 `request_failed`. */
function isTransient(error: unknown): boolean {
  if (error instanceof SignInNetworkError) return true;
  if (!(error instanceof SignInHttpError)) return false;
  return error.code === "request_failed" || isRetryableError(error);
}

type DeviceCode = { deviceAuthId: string; userCode: string; intervalMs: number };
type Authorization = { authorizationCode: string; codeVerifier: string };
type PollAnswer =
  | { status: "pending" | "slow_down" }
  | { status: "complete"; value: Authorization };

/**
 * Device-code sign-in for a ChatGPT subscription. The runtime's own flow ends the sign-in on
 * the first 5xx while the person is still approving; this one keeps waiting through transient
 * provider failures until the code itself expires.
 */
export function createChatGptDeviceCodeLogin(options: { fetch?: typeof fetch } = {}) {
  const request = options.fetch ?? fetch;

  return async (interaction: AuthInteraction): Promise<OAuthCredential> => {
    const signal = interaction.signal ?? new AbortController().signal;
    const post = async (step: string, url: string, body: string, type: string) => {
      try {
        return await request(url, {
          method: "POST",
          headers: { accept: "application/json", "content-type": type },
          body,
          signal: deadlineSignal(REQUEST_TIMEOUT_MS, signal),
        });
      } catch (error) {
        signal.throwIfAborted();
        throw new SignInNetworkError(step, { cause: error });
      }
    };
    const postJson = (step: string, url: string, body: object) =>
      post(step, url, JSON.stringify(body), "application/json");
    const readJson = async (response: Response) => {
      try {
        return await readBoundedJsonResponse<Record<string, unknown>>(
          response,
          MAX_RESPONSE_BYTES,
          signal,
        );
      } catch (error) {
        signal.throwIfAborted();
        throw new Error("Device sign-in returned an unreadable response.", { cause: error });
      }
    };
    const failure = async (step: string, response: Response) =>
      new SignInHttpError(step, response.status, await errorCode(response));
    const persist = <T>(operation: () => Promise<T>) =>
      retry(operation, { attempts: REQUEST_ATTEMPTS, retryable: isTransient, signal });

    const device = await persist(async (): Promise<DeviceCode> => {
      const response = await postJson("code request", USER_CODE_URL, { client_id: CLIENT_ID });
      if (!response.ok) throw await failure("code request", response);
      const json = await readJson(response);
      const interval = typeof json.interval === "string" ? Number(json.interval) : json.interval;
      if (typeof json.device_auth_id !== "string" || typeof json.user_code !== "string") {
        throw new Error("Device sign-in returned no code.");
      }
      return {
        deviceAuthId: json.device_auth_id,
        userCode: json.user_code,
        intervalMs:
          typeof interval === "number" && Number.isFinite(interval) && interval >= 0
            ? Math.max(MIN_INTERVAL_MS, interval * 1000)
            : DEFAULT_INTERVAL_MS,
      };
    });

    interaction.notify({
      type: "device_code",
      userCode: device.userCode,
      verificationUri: VERIFICATION_URI,
      intervalSeconds: device.intervalMs / 1000,
      expiresInSeconds: CHATGPT_DEVICE_CODE_TTL_SECONDS,
    });

    const pollOnce = async (): Promise<PollAnswer> => {
      const response = await postJson("poll", DEVICE_TOKEN_URL, {
        device_auth_id: device.deviceAuthId,
        user_code: device.userCode,
      });
      if (response.ok) {
        const json = await readJson(response);
        if (typeof json.authorization_code !== "string" || typeof json.code_verifier !== "string") {
          throw new Error("Device sign-in returned no authorization code.");
        }
        return {
          status: "complete",
          value: { authorizationCode: json.authorization_code, codeVerifier: json.code_verifier },
        };
      }
      // The person has not approved the code yet.
      if (response.status === 403 || response.status === 404) {
        cancelResponseBody(response);
        return { status: "pending" };
      }
      const error = await failure("poll", response);
      if (error.code === "deviceauth_authorization_pending") return { status: "pending" };
      if (error.code === "slow_down") return { status: "slow_down" };
      throw error;
    };

    let intervalMs = device.intervalMs;
    const authorization = await pollUntil(
      async () => {
        let answer: PollAnswer;
        try {
          answer = await pollOnce();
        } catch (error) {
          if (!isTransient(error)) throw error;
          getLogger().warn("model sign-in poll failed; still waiting", {
            status: error instanceof SignInHttpError ? error.status : undefined,
          });
          return undefined;
        }
        if (answer.status === "slow_down") intervalMs += SLOW_DOWN_STEP_MS;
        return answer.status === "complete" ? answer.value : undefined;
      },
      {
        intervalMs: () => intervalMs,
        timeoutMs: CHATGPT_DEVICE_CODE_TTL_SECONDS * 1000,
        signal,
        onTimeout: () => {
          throw new Error("Sign-in expired.");
        },
      },
    );

    return persist(async () => {
      const response = await post(
        "token exchange",
        TOKEN_URL,
        new URLSearchParams({
          grant_type: "authorization_code",
          client_id: CLIENT_ID,
          code: authorization.authorizationCode,
          code_verifier: authorization.codeVerifier,
          redirect_uri: DEVICE_REDIRECT_URI,
        }).toString(),
        "application/x-www-form-urlencoded",
      );
      if (!response.ok) throw await failure("token exchange", response);
      return credentialOf(await readJson(response));
    });
  };
}

/** The OAuth error code a failed answer carries, read only to decide what to do next. */
async function errorCode(response: Response): Promise<string | undefined> {
  let json: { error?: unknown };
  try {
    json = await readBoundedJsonResponse(response, MAX_RESPONSE_BYTES);
  } catch {
    // An error page that is not JSON carries no code.
    return undefined;
  }
  const error = json.error;
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : error;
  return typeof code === "string" ? code : undefined;
}

function credentialOf(json: Record<string, unknown>): OAuthCredential {
  const { access_token: access, refresh_token: refresh, expires_in: expiresIn } = json;
  if (
    typeof access !== "string" ||
    typeof refresh !== "string" ||
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn)
  ) {
    throw new Error("Device sign-in returned an invalid credential.");
  }
  const accountId = accountIdOf(access);
  if (!accountId) throw new Error("Device sign-in returned a credential with no account.");
  return { type: "oauth", access, refresh, expires: Date.now() + expiresIn * 1000, accountId };
}

function accountIdOf(accessToken: string): string | undefined {
  try {
    const payload = JSON.parse(
      Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as Record<string, { chatgpt_account_id?: unknown } | undefined>;
    const accountId = payload[ACCOUNT_CLAIM]?.chatgpt_account_id;
    return typeof accountId === "string" && accountId ? accountId : undefined;
  } catch {
    return undefined;
  }
}
