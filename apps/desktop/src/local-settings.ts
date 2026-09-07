import {
  isLocalSettingsProcedure,
  LOCAL_SETTINGS_TOKEN_HEADER,
} from "@rakazo/contracts/local-settings";
import { isLoopbackHost } from "./setup-config.js";

/** Only a fixed local target and known settings procedures can receive host authority. */
export async function requestLocalSettings(
  target: { origin: string; token: string },
  pathname: unknown,
  body: unknown,
  request: typeof fetch,
): Promise<{ status: number; body: string }> {
  const url = new URL(target.origin);
  if (
    url.origin !== target.origin ||
    !["http:", "https:"].includes(url.protocol) ||
    !isLoopbackHost(url.hostname) ||
    typeof pathname !== "string" ||
    !isLocalSettingsProcedure(pathname) ||
    typeof body !== "string" ||
    body.length > 1024 * 1024
  ) {
    throw new Error("Invalid local settings request");
  }
  const response = await request(`${target.origin}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", [LOCAL_SETTINGS_TOKEN_HEADER]: target.token },
    body,
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(120_000),
  });
  return { status: response.status, body: await response.text() };
}
