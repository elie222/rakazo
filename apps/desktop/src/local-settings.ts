import {
  LOCAL_COMPUTER_HOST_PATH,
  LOCAL_SETTINGS_TOKEN_HEADER,
} from "@rakazo/contracts/local-settings";
import { isLoopbackHost } from "@rakazo/contracts/network-host";

/** Called by native main only after the local host permission flow. Never exposes the token. */
export async function saveLocalComputerHost(
  target: { origin: string; token: string },
  computerHost: "docker" | "this-mac",
  request: typeof fetch,
): Promise<void> {
  const url = new URL(target.origin);
  if (
    url.origin !== target.origin ||
    !["http:", "https:"].includes(url.protocol) ||
    !isLoopbackHost(url.hostname)
  ) {
    throw new Error("Invalid local settings target");
  }
  const response = await request(`${target.origin}${LOCAL_COMPUTER_HOST_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", [LOCAL_SETTINGS_TOKEN_HEADER]: target.token },
    body: JSON.stringify({ computerHost }),
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("Could not save local computer choice");
}
