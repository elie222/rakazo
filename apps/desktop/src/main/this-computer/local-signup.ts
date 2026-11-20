import { LOCAL_SIGNUP_COOKIE, localSignupKey } from "@rakazo/core/node/local-signup";
import type { Session } from "electron";

/**
 * Lets this app's window create accounts on the server the app runs. The page cannot read the
 * cookie, and only the auth routes receive it, so a browser or another user reaching the same
 * port is still refused. Cookies ignore the port, so it is removed whenever the session opens
 * any other server, which could be another server on the same host.
 */
export async function syncLocalSignup(
  value: Pick<Session, "cookies">,
  localWebUrl: string,
  stackToken: string | null,
) {
  const url = new URL(localWebUrl).origin;
  if (stackToken === null) return value.cookies.remove(url, LOCAL_SIGNUP_COOKIE);
  await value.cookies.set({
    url,
    name: LOCAL_SIGNUP_COOKIE,
    value: localSignupKey(stackToken),
    path: "/api/auth",
    httpOnly: true,
    sameSite: "lax",
  });
}
