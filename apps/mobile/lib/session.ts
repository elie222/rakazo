import * as SecureStore from "expo-secure-store";
import { stopLiveNotifications } from "./live-notifications";

const SESSION_KEY = "rakazo.session_token";

/** In-memory gate so a failed SecureStore wipe cannot keep sending the old bearer. */
let sessionInvalidated = false;
let sessionFallback: string | undefined;

export async function loadSessionToken() {
  const snapshot = await snapshotSessionToken();
  return snapshot.ok ? snapshot.value : "";
}

export async function saveSessionToken(token: string) {
  await SecureStore.setItemAsync(SESSION_KEY, token);
  sessionInvalidated = false;
  sessionFallback = undefined;
}

/** Clears the session. Returns false only when SecureStore could neither delete nor overwrite. */
export async function clearSessionToken(): Promise<boolean> {
  await stopLiveNotifications(true).catch(() => undefined);
  try {
    await SecureStore.deleteItemAsync(SESSION_KEY);
    sessionInvalidated = false;
    sessionFallback = undefined;
    return true;
  } catch {
    try {
      await SecureStore.setItemAsync(SESSION_KEY, "");
      sessionInvalidated = false;
      sessionFallback = undefined;
      return true;
    } catch {
      sessionInvalidated = true;
      sessionFallback = undefined;
      return false;
    }
  }
}

/** Restores the current-server session in memory even when persistence is unavailable. */
export async function restoreSessionToken(token: string) {
  if (!token) {
    sessionInvalidated = false;
    sessionFallback = undefined;
    return;
  }
  try {
    await saveSessionToken(token);
  } catch {
    sessionInvalidated = false;
    sessionFallback = token;
  }
}

/** Snapshots the active token without treating an unreadable store as an empty session. */
export async function snapshotSessionToken(): Promise<{ ok: true; value: string } | { ok: false }> {
  if (sessionFallback !== undefined) return { ok: true, value: sessionFallback };
  if (sessionInvalidated) return { ok: true, value: "" };
  try {
    return { ok: true, value: (await SecureStore.getItemAsync(SESSION_KEY)) ?? "" };
  } catch {
    return { ok: false };
  }
}

export function tokenFromAuthResponse(res: Response, body: unknown) {
  const fromJson = jsonToken(body);
  if (fromJson) return fromJson;
  const cookies = res.headers.get("set-cookie") ?? "";
  const encoded = cookies.match(/(?:^|,\s*)(?:__Secure-)?better-auth\.session_token=([^;,]*)/)?.[1];
  if (!encoded) return "";
  try {
    return decodeURIComponent(encoded);
  } catch {
    return "";
  }
}

function jsonToken(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const record = body as Record<string, unknown>;
  if (typeof record.token === "string" && record.token) return record.token;
  const session = record.session;
  if (
    session &&
    typeof session === "object" &&
    typeof (session as { token?: string }).token === "string"
  ) {
    return (session as { token: string }).token;
  }
  return "";
}
