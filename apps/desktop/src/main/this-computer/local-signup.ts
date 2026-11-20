import { LOCAL_SIGNUP_COOKIE, localSignupKey } from "@rakazo/core/node/local-signup";
import type { Session } from "electron";

/**
 * Lets this app's window create accounts on the server the app runs. The page cannot read the
 * cookie, and only the auth routes receive it, so a browser or another user reaching the same
 * port is still refused.
 */
export async function allowLocalSignup(
  value: Pick<Session, "cookies">,
  webUrl: string,
  stackToken: string | null,
) {
  if (stackToken === null) return;
  await value.cookies.set({
    url: new URL(webUrl).origin,
    name: LOCAL_SIGNUP_COOKIE,
    value: localSignupKey(stackToken),
    path: "/api/auth",
    httpOnly: true,
    sameSite: "lax",
  });
}
