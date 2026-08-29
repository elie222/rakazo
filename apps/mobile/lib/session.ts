import * as SecureStore from "expo-secure-store";
import { stopLiveNotifications } from "./live-notifications";

const SESSION_KEY = "rakazo.session_token";

export async function loadSessionToken() {
  try {
    return (await SecureStore.getItemAsync(SESSION_KEY)) ?? "";
  } catch {
    return "";
  }
}

export async function saveSessionToken(token: string) {
  await SecureStore.setItemAsync(SESSION_KEY, token);
}

export async function clearSessionToken() {
  await stopLiveNotifications(true).catch(() => undefined);
  await SecureStore.deleteItemAsync(SESSION_KEY);
}

export function tokenFromAuthResponse(res: Response, body: unknown) {
  const fromJson = jsonToken(body);
  if (fromJson) return fromJson;
  const cookies = res.headers.get("set-cookie") ?? "";
  const match = cookies.match(/better-auth\.session_token=([^;]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : "";
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
