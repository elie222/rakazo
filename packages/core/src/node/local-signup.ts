import { createHmac } from "node:crypto";

/** The cookie that lets the desktop app's own window create accounts on the server it runs. */
export const LOCAL_SIGNUP_COOKIE = "rakazo_local_signup";

/**
 * What that cookie holds: derived from the private stack token, so a copy sent to another local
 * server can only create accounts here, never change the host settings the token itself unlocks.
 */
export function localSignupKey(stackToken: string): string {
  return createHmac("sha256", stackToken).update("rakazo:local-signup").digest("hex");
}
