import { authHeaders, clearSpace, currentApiBase, fetchMobileJson } from "./api";
import { t } from "./i18n";
import {
  currentSessionGeneration,
  replaceSessionTokenIfCurrent,
  tokenFromAuthResponse,
} from "./session";
import { authErrorText } from "./user-error";

let inFlight = false;

/** Better Auth Expo proxy transfers the state cookie into the native auth browser. */
export async function continueWithSso(
  action: "sign-in" | "link" | "reauthenticate" = "sign-in",
): Promise<boolean> {
  if (inFlight) return false;
  inFlight = true;
  try {
    const apiBase = currentApiBase();
    const generation = currentSessionGeneration();
    const requireCurrentSession = () => {
      if (apiBase !== currentApiBase() || generation !== currentSessionGeneration())
        throw new Error(t("Could not continue"));
    };
    const callbackURL = action === "sign-in" ? "rakazo://sign-in" : "rakazo://account";
    const headers = action === "sign-in" ? {} : await authHeaders();
    requireCurrentSession();
    const previous = action === "reauthenticate" ? await sessionUser(apiBase, headers) : undefined;
    requireCurrentSession();
    const { response, body } = await fetchMobileJson<{ url?: string; code?: string }>(
      `${apiBase}/api/auth/${action === "link" ? "link-social" : "sign-in/social"}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "rakazo://",
          "x-skip-oauth-proxy": "true",
          ...headers,
        },
        body: JSON.stringify({
          provider: "oidc",
          callbackURL,
          errorCallbackURL: callbackURL,
          disableRedirect: true,
          ...(action === "reauthenticate" ? { additionalData: { reauthenticate: true } } : {}),
        }),
      },
    );
    if (!response.ok || !body.url) throw new Error(authErrorText(body, t("Could not continue")));
    const authorization = new URL(body.url);
    if (authorization.protocol !== "https:" || !authorization.searchParams.get("state"))
      throw new Error(t("Could not continue"));
    const params = new URLSearchParams({ authorizationURL: authorization.href });
    const stateCookie = response.headers
      .get("set-cookie")
      ?.match(/(?:^|,\s*)(?:__Secure-)?better-auth\.oauth_state=([^;,]*)/)?.[1];
    if (stateCookie) params.set("oauthState", decodeURIComponent(stateCookie));
    // Defer the new native module so password auth still works in older binaries.
    const { openAuthSessionAsync } = await import("expo-web-browser").catch(() => {
      throw new Error(t("Could not continue"));
    });
    const result = await openAuthSessionAsync(
      `${apiBase}/api/auth/expo-authorization-proxy?${params}`,
      callbackURL,
    );
    if (result.type !== "success") return false;
    const callback = new URL(result.url);
    if (
      callback.protocol !== "rakazo:" ||
      callback.host !== new URL(callbackURL).host ||
      (callback.pathname && callback.pathname !== "/")
    )
      throw new Error(t("Could not continue"));
    if (callback.searchParams.has("error"))
      throw new Error(
        authErrorText({ code: callback.searchParams.get("error") }, t("Could not continue")),
      );
    requireCurrentSession();
    if (action === "link") return true;
    const cookie = callback.searchParams.get("cookie");
    const token = cookie
      ? tokenFromAuthResponse(new Response(null, { headers: { "set-cookie": cookie } }), null)
      : "";
    if (!token) throw new Error(t("Sign-in did not return a session"));
    const user = await sessionUser(apiBase, { authorization: `Bearer ${token}` });
    if (!user || (action === "reauthenticate" && (!previous || previous !== user)))
      throw new Error(t("Could not continue"));
    requireCurrentSession();
    if (action === "sign-in" && !(await clearSpace()))
      throw new Error(t("Could not clear the previous space"));
    return await replaceSessionTokenIfCurrent(generation, token);
  } finally {
    inFlight = false;
  }
}

async function sessionUser(apiBase: string, headers: Record<string, string>): Promise<string> {
  const { response, body } = await fetchMobileJson<{ user?: { id?: string } }>(
    `${apiBase}/api/auth/get-session`,
    { headers: { origin: "rakazo://", ...headers } },
  );
  if (!response.ok || typeof body?.user?.id !== "string") throw new Error(t("Could not continue"));
  return body.user.id;
}
