import type { AuthCapabilities } from "@rakazo/contracts";
import { hostMatchesPasskeyRpId, passkeyOfferDismissedKey, shouldOfferPasskey } from "@rakazo/core";
import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import { Alert, Platform } from "react-native";
import type * as NativePasskeys from "react-native-passkeys";
import {
  authHeaders,
  clearSpace,
  currentApiBase,
  fetchMobileJson,
  passwordResetCapabilities,
} from "./api";
import { t } from "./i18n";
import {
  currentSessionGeneration,
  replaceSessionTokenIfCurrent,
  tokenFromAuthResponse,
} from "./session";
import { authResponseErrorText, errorText, sessionSaveErrorText } from "./user-error";

export type MobilePasskey = { id: string; name: string | null; createdAt: string };

type CreationOptions = Parameters<typeof NativePasskeys.create>[0];
type RequestOptions = Parameters<typeof NativePasskeys.get>[0];

let nativeModule: Promise<typeof NativePasskeys | null> | undefined;

/** Deferred so a JS update on a binary without the native module hides passkeys instead of crashing. */
function loadNative(): Promise<typeof NativePasskeys | null> {
  nativeModule ??= import("react-native-passkeys")
    .then((module) => (module.isSupported() ? module : null))
    .catch(() => null);
  return nativeModule;
}

/** Relying parties this binary is associated with (app.config.ts). */
function associatedRpIds(): string[] {
  const ids: unknown = Constants.expoConfig?.extra?.passkeyRpIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

/** Native association alone does not bind a server-supplied challenge to the API host. */
function serverMatchesRp(apiBase: string, rpId: string | undefined | null): boolean {
  if (!rpId || !associatedRpIds().includes(rpId.toLowerCase())) return false;
  const server = new URL(apiBase);
  return server.protocol === "https:" && hostMatchesPasskeyRpId(server.hostname, rpId);
}

/**
 * Passkeys work only on a device that supports them, for a server this binary is associated
 * with, whose domain also vouches for this platform's app. Older servers omit that, so: hidden.
 */
export async function passkeysAvailable(
  capabilities: Pick<AuthCapabilities, "passkeyRpId" | "nativePasskeys"> | null | undefined,
): Promise<boolean> {
  const rpId = capabilities?.passkeyRpId;
  if (!serverMatchesRp(currentApiBase(), rpId)) return false;
  const platform = Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : null;
  if (!platform || capabilities?.nativePasskeys?.[platform] !== true) return false;
  return (await loadNative()) !== null;
}

/** A dismissed native sheet resolves to null or rejects with a cancellation, never an error to show. */
function cancelled(error: unknown): boolean {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  return /cancel|NotAllowedError|AbortError/i.test(
    `${String(code ?? "")} ${String(message ?? "")}`,
  );
}

function challengeCookie(response: Response): string {
  // Sent back exactly as issued: the server reads it as a signed cookie.
  const match = response.headers
    .get("set-cookie")
    ?.match(/(?:^|,\s*)((?:__Secure-)?better-auth\.better-auth-passkey)=([^;,]*)/);
  if (!match?.[2]) throw new Error(t("Could not continue"));
  return `${match[1]}=${match[2]}`;
}

/**
 * Challenge requests keep the platform cookie jar out. With cookies on, React Native's iOS
 * networking first fills Cookie from the shared jar (which already holds the challenge cookie
 * from the options response) and then appends ours with a comma, so the signed value no longer
 * parses and the server answers CHALLENGE_NOT_FOUND. The cookie is sent explicitly instead.
 */
const WITHOUT_COOKIE_JAR = { credentials: "omit" } as const;

function passkeyErrorText(status: number, body: unknown, invalidJson?: boolean): string {
  const code = body && typeof body === "object" && "code" in body ? body.code : undefined;
  if (code === "SESSION_NOT_FRESH") return t("Sign in again");
  return authResponseErrorText(status, body, invalidJson);
}

/** Server and session must not change while the native sheet is open. */
function captureFlow() {
  const apiBase = currentApiBase();
  const generation = currentSessionGeneration();
  return {
    apiBase,
    generation,
    requireCurrent() {
      if (apiBase !== currentApiBase() || generation !== currentSessionGeneration())
        throw new Error(t("Could not continue"));
    },
  };
}

let inFlight = false;

async function exclusive<T>(run: () => Promise<T>, idle: T): Promise<T> {
  if (inFlight) return idle;
  inFlight = true;
  try {
    return await run();
  } finally {
    inFlight = false;
  }
}

/** Signs in with a passkey. Resolves false when the person dismisses the system sheet. */
export function signInWithPasskey(): Promise<boolean> {
  return exclusive(async () => {
    const flow = captureFlow();
    const passkeys = await loadNative();
    if (!passkeys) throw new Error(t("Could not continue"));
    const options = await fetchMobileJson<RequestOptions>(
      `${flow.apiBase}/api/auth/passkey/generate-authenticate-options`,
      { ...WITHOUT_COOKIE_JAR, headers: { origin: "rakazo://" } },
      {} as RequestOptions,
    );
    if (!options.response.ok || options.invalidJson)
      throw new Error(passkeyErrorText(options.response.status, options.body, options.invalidJson));
    if (!serverMatchesRp(flow.apiBase, options.body.rpId)) throw new Error(t("Could not continue"));
    const cookie = challengeCookie(options.response);
    let credential: Awaited<ReturnType<typeof passkeys.get>>;
    try {
      credential = await passkeys.get(options.body);
    } catch (error) {
      if (cancelled(error)) return false;
      throw new Error(t("Could not continue"));
    }
    if (!credential) return false;
    flow.requireCurrent();
    const { response, body, invalidJson } = await fetchMobileJson<unknown>(
      `${flow.apiBase}/api/auth/passkey/verify-authentication`,
      {
        ...WITHOUT_COOKIE_JAR,
        method: "POST",
        headers: { "content-type": "application/json", origin: "rakazo://", cookie },
        body: JSON.stringify({ response: credential }),
      },
      {},
    );
    if (!response.ok || invalidJson)
      throw new Error(passkeyErrorText(response.status, body, invalidJson));
    const token = tokenFromAuthResponse(response, body);
    if (!token) throw new Error(t("Sign-in did not return a session"));
    flow.requireCurrent();
    try {
      if (!(await clearSpace()))
        throw new Error(t("Could not save your sign-in on this device. Try again."));
      return await replaceSessionTokenIfCurrent(flow.generation, token);
    } catch (error) {
      throw new Error(sessionSaveErrorText(error));
    }
  }, false);
}

/** Registers a passkey for the signed-in account. Resolves false when the sheet is dismissed. */
export function addPasskey(): Promise<boolean> {
  return exclusive(async () => {
    const flow = captureFlow();
    const passkeys = await loadNative();
    if (!passkeys) throw new Error(t("Could not continue"));
    const headers = await authHeaders();
    flow.requireCurrent();
    const options = await fetchMobileJson<CreationOptions>(
      `${flow.apiBase}/api/auth/passkey/generate-register-options`,
      { ...WITHOUT_COOKIE_JAR, headers: { origin: "rakazo://", ...headers } },
      {} as CreationOptions,
    );
    if (!options.response.ok || options.invalidJson)
      throw new Error(passkeyErrorText(options.response.status, options.body, options.invalidJson));
    if (!serverMatchesRp(flow.apiBase, options.body.rp?.id))
      throw new Error(t("Could not continue"));
    const cookie = challengeCookie(options.response);
    let credential: Awaited<ReturnType<typeof passkeys.create>>;
    try {
      credential = await passkeys.create(options.body);
    } catch (error) {
      if (cancelled(error)) return false;
      throw new Error(t("Could not continue"));
    }
    if (!credential) return false;
    flow.requireCurrent();
    const { response, body, invalidJson } = await fetchMobileJson<unknown>(
      `${flow.apiBase}/api/auth/passkey/verify-registration`,
      {
        ...WITHOUT_COOKIE_JAR,
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "rakazo://",
          cookie,
          ...headers,
        },
        body: JSON.stringify({ response: credential }),
      },
      {},
    );
    if (!response.ok || invalidJson)
      throw new Error(passkeyErrorText(response.status, body, invalidJson));
    return true;
  }, false);
}

async function passkeyRequest<T>(path: string, body?: unknown): Promise<T> {
  const { response, body: result } = await fetchMobileJson<unknown>(
    `${currentApiBase()}/api/auth/passkey/${path}`,
    {
      method: body === undefined ? "GET" : "POST",
      headers: {
        origin: "rakazo://",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(await authHeaders()),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    null,
  );
  if (!response.ok) throw new Error(passkeyErrorText(response.status, result));
  return result as T;
}

export async function listPasskeys(): Promise<MobilePasskey[]> {
  const result = await passkeyRequest<unknown>("list-user-passkeys");
  if (!Array.isArray(result)) throw new Error(t("Could not continue"));
  return result.flatMap((item: Record<string, unknown> | null) =>
    item && typeof item.id === "string"
      ? [
          {
            id: item.id,
            name: typeof item.name === "string" && item.name.trim() ? item.name : null,
            createdAt: typeof item.createdAt === "string" ? item.createdAt : "",
          },
        ]
      : [],
  );
}

export async function renamePasskey(id: string, name: string): Promise<void> {
  await passkeyRequest("update-passkey", { id, name });
}

export async function deletePasskey(id: string): Promise<void> {
  await passkeyRequest("delete-passkey", { id });
}

const offered = new Set<string>();

/** Whether this account should see the one-time offer: right after signup, never after dismissal. */
async function passkeyOfferDue(userId: string): Promise<boolean> {
  const capabilities = await passwordResetCapabilities();
  if (!(await passkeysAvailable(capabilities))) return false;
  if ((await SecureStore.getItemAsync(passkeyOfferDismissedKey(userId))) === "1") return false;
  const { response, body } = await fetchMobileJson<{
    user?: { id?: string; createdAt?: string };
    session?: { createdAt?: string };
  } | null>(
    `${currentApiBase()}/api/auth/get-session`,
    { headers: { origin: "rakazo://", ...(await authHeaders()) } },
    null,
  );
  if (!response.ok || body?.user?.id !== userId || !body.user.createdAt || !body.session?.createdAt)
    return false;
  // Skip the list unless the session is the account's first one.
  const firstSession = {
    userCreatedAt: body.user.createdAt,
    sessionCreatedAt: body.session.createdAt,
    dismissed: false,
  };
  if (!shouldOfferPasskey({ ...firstSession, passkeyCount: 0 })) return false;
  return shouldOfferPasskey({ ...firstSession, passkeyCount: (await listPasskeys()).length });
}

/** Offers a passkey once after signup with a native alert; either answer ends the offer for good. */
export async function offerPasskeyOnce(userId: string, isActive: () => boolean): Promise<void> {
  if (offered.has(userId)) return;
  offered.add(userId);
  let due: boolean;
  try {
    due = await passkeyOfferDue(userId);
  } catch {
    // A failed check decides nothing, so the next visit to the inbox asks again.
    offered.delete(userId);
    return;
  }
  if (!due) return;
  if (!isActive()) {
    offered.delete(userId);
    return;
  }
  const dismiss = () =>
    void SecureStore.setItemAsync(passkeyOfferDismissedKey(userId), "1").catch(() => undefined);
  Alert.alert(t("Add a passkey for faster sign-in?"), undefined, [
    { text: t("Not now"), style: "cancel", onPress: dismiss },
    {
      text: t("Add passkey"),
      onPress: () => {
        dismiss();
        addPasskey().catch((error: unknown) =>
          Alert.alert(errorText(error, t("Could not continue"))),
        );
      },
    },
  ]);
}

/** Test-only: forget the loaded native module and in-process offer state. */
export function resetPasskeysForTests(): void {
  nativeModule = undefined;
  inFlight = false;
  offered.clear();
}
