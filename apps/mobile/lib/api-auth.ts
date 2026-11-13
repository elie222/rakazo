import { t } from "@lingui/core/macro";
import type { AccountSecurity, AuthCapabilities } from "@rakazo/contracts";
import {
  accountSecuritySchema,
  authCapabilitiesSchema,
  legacyAccountSecurity,
  legacyAuthCapabilitiesSchema,
  SIGNUP_SURFACE_HEADER,
} from "@rakazo/contracts";
import { displayName, signupRequiresEmailVerification } from "@rakazo/core";
import { Platform } from "react-native";
import type { PendingSignOut } from "./api";
import {
  authHeaders,
  beginPasswordChange,
  currentApiBase,
  deliverSignOutRecord,
  endPasswordChange,
  endpointChangeInProgress,
  fetchMobileJson,
  savePendingSignOut,
  selectedSpaceId,
} from "./api";
import { clearSpace } from "./api-server";
import { getActiveUiLocale } from "./i18n";
import { resumeLiveNotifications } from "./live-notifications";
import { DEFAULT_API } from "./server-config";
import { serverHeaders } from "./server-headers";
import {
  clearSessionToken,
  currentSessionGeneration,
  rotateSessionTokenIfCurrent,
  saveRotatedSessionToken,
  saveSessionToken,
  sessionSaveInProgress,
  snapshotSessionToken,
  snapshotStoredSessionToken,
  tokenFromAuthResponse,
} from "./session";
import { authResponseErrorText, sessionSaveErrorText } from "./user-error";

async function postAuth(path: string, input: object, apiBase = currentApiBase()) {
  return fetchMobileJson<unknown>(
    `${apiBase}/api/auth/${path}`,
    {
      method: "POST",
      // The app authenticates by bearer token only; a server's cookie must not outlive a switch.
      credentials: "omit",
      // Emails sent before an account has a language follow the one this app shows.
      headers: {
        "content-type": "application/json",
        origin: "rakazo://",
        "accept-language": getActiveUiLocale(),
        [SIGNUP_SURFACE_HEADER]: Platform.OS,
      },
      body: JSON.stringify(input),
    },
    {},
  );
}
async function authenticate(
  path: string,
  input: object,
  missingSession: string,
): Promise<{ verificationRequired: boolean }> {
  const apiBase = currentApiBase();
  const generation = currentSessionGeneration();
  // A switch replaces the stored headers, and the cleanup below may still need them for this server.
  const headers = serverHeaders(apiBase);
  const { response, body, invalidJson } = await postAuth(path, input, apiBase);
  if (!response.ok || invalidJson) {
    throw new Error(authResponseErrorText(response.status, body, invalidJson));
  }
  const token = tokenFromAuthResponse(response, body);
  if (path === "sign-up/email" && signupRequiresEmailVerification(body))
    return { verificationRequired: true };
  if (!token) throw new Error(missingSession);
  // A server switch or sign-out while the request was in flight: this token belongs to a server
  // the app no longer uses, so it is never saved and its session is ended there. A switch still
  // running has already cleared the session but not yet moved to the new server.
  const current = () =>
    apiBase === currentApiBase() &&
    generation === currentSessionGeneration() &&
    !endpointChangeInProgress();
  let saved = false;
  if (current()) {
    try {
      if (!(await clearSpace()))
        throw new Error(t`Could not save your sign-in on this device. Try again.`);
      // Checked in the same tick the save starts; a failed write leaves no session behind.
      if (current()) {
        await saveSessionToken(token);
        // A change that lands while the token is being written clears it again.
        saved = currentSessionGeneration() === generation + 1 && apiBase === currentApiBase();
      }
    } catch (error) {
      throw new Error(sessionSaveErrorText(error));
    }
  }
  if (!saved) {
    // Recorded like a sign-out, so a server that cannot be reached now still ends it later.
    const revocation: PendingSignOut = { apiBase, token, headers, recordedAt: Date.now() };
    void deliverSignOutRecord(revocation, await savePendingSignOut(revocation));
    throw new Error(t`Could not continue`);
  }
  return { verificationRequired: false };
}
/** Signs in with an identity token from a native provider such as Sign in with Apple. */
export function signInWithIdentityToken(
  provider: string,
  token: string,
  user?: { name?: { firstName?: string; lastName?: string }; email?: string },
) {
  if (currentApiBase() !== DEFAULT_API || !DEFAULT_API.startsWith("https://"))
    throw new Error(t`Could not continue`);
  return authenticate(
    "sign-in/social",
    { provider, idToken: { token, ...(user ? { user } : {}) } },
    t`Sign-in did not return a session`,
  );
}
export function signIn(email: string, password: string) {
  return authenticate("sign-in/email", { email, password }, t`Sign-in did not return a session`);
}
export function signUp(email: string, password: string, name: string) {
  return authenticate(
    "sign-up/email",
    { email, password, name },
    t`Sign-up did not return a session`,
  );
}
/** Always succeeds when the server accepts the request, whether or not an email was sent. */
export async function sendSignInCode(email: string): Promise<void> {
  const { response, body, invalidJson } = await postAuth("email-otp/send-verification-otp", {
    email,
    type: "sign-in",
  });
  if (!response.ok) throw new Error(authResponseErrorText(response.status, body, invalidJson));
}
/** Signs in with an emailed code, creating the account (with `name`) when none exists. */
export async function signInWithCode(email: string, code: string, name?: string): Promise<void> {
  await authenticate(
    "sign-in/email-otp",
    { email, otp: code, ...(name ? { name } : {}) },
    t`Sign-in did not return a session`,
  );
}
export type PasswordResetCapabilities = AuthCapabilities;
export async function passwordResetCapabilities(): Promise<PasswordResetCapabilities> {
  const { response, body } = await fetchMobileJson<unknown>(
    `${currentApiBase()}/api/auth/capabilities`,
    { headers: { origin: "rakazo://" } },
  );
  if (!response.ok) throw new Error(t`Could not load sign-in options`);
  return authCapabilitiesSchema.or(legacyAuthCapabilitiesSchema).parse(body);
}
export async function requestPasswordReset(email: string, redirectTo: string): Promise<void> {
  const { response, body, invalidJson } = await fetchMobileJson<unknown>(
    `${currentApiBase()}/api/auth/request-password-reset`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "rakazo://",
        "accept-language": getActiveUiLocale(),
      },
      body: JSON.stringify({ email, redirectTo }),
    },
    {},
  );
  if (!response.ok)
    throw new Error(
      authResponseErrorText(response.status, body, invalidJson, t`Could not send reset email`),
    );
}
export async function updateAccountName(name: string): Promise<void> {
  const nextName = name.trim();
  if (!nextName || nextName.length > 80 || !displayName(nextName, "")) {
    throw new Error(t`Could not update name`);
  }
  const { response, body, invalidJson } = await fetchMobileJson<unknown>(
    `${currentApiBase()}/api/auth/update-user`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "rakazo://",
        ...(await authHeaders()),
      },
      body: JSON.stringify({ name: nextName }),
    },
    {},
  );
  if (!response.ok)
    throw new Error(
      authResponseErrorText(response.status, body, invalidJson, t`Could not update name`),
    );
}
/** A hash of the change whose new session is not saved yet; never the passwords themselves. */
let unsavedPasswordChange: string | undefined;
/** A 53-bit hash, so an unchanged form can be recognized without keeping its passwords. */
function submissionHash(currentPassword: string, newPassword: string) {
  const text = JSON.stringify([currentPassword, newPassword]);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  beginPasswordChange();
  const submission = submissionHash(currentPassword, newPassword);
  try {
    // An earlier change whose new session was not saved is finished first, so this change is sent
    // with that session; if it still cannot be saved, nothing new is submitted.
    const saved = await saveRotatedSessionToken();
    const finished = unsavedPasswordChange;
    unsavedPasswordChange = undefined;
    // The server already accepted this exact change; sending it again would fail.
    if (saved && finished === submission) return;
    await replaceSessionAfterPasswordChange(currentPassword, newPassword, submission);
  } finally {
    endPasswordChange();
  }
}
async function replaceSessionAfterPasswordChange(
  currentPassword: string,
  newPassword: string,
  submission: string,
) {
  const apiBase = currentApiBase();
  const generation = currentSessionGeneration();
  const headers = await authHeaders();
  // The token the server replaces is the one this request carries; a second read could differ.
  const previousToken = headers.authorization?.slice("Bearer ".length) ?? "";
  // Without it the cookie jar could still sign the change, and the queue could not move over.
  if (!previousToken) throw new Error(t`Could not change password`);
  const { response, body, invalidJson } = await fetchMobileJson<unknown>(
    `${apiBase}/api/auth/change-password`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "rakazo://",
        ...headers,
      },
      body: JSON.stringify({ currentPassword, newPassword, revokeOtherSessions: true }),
    },
    {},
  );
  if (!response.ok)
    throw new Error(
      authResponseErrorText(response.status, body, invalidJson, t`Could not change password`),
    );
  // Revoking other sessions also revokes this one; keep the replacement the server issued.
  const token = tokenFromAuthResponse(response, body);
  if (!token) return;
  // A sign-out or server switch changes the session while the request is in flight.
  if (currentApiBase() !== apiBase) return;
  const maybeResume = async () => {
    // Our save is the only change allowed; a sign-out during it must not restart notifications.
    const spaceId = selectedSpaceId();
    if (spaceId && currentSessionGeneration() === generation + 1) {
      await resumeLiveNotifications(apiBase, token, spaceId).catch(() => undefined);
    }
  };
  try {
    // The same account on the same server keeps its unsent messages.
    if (!(await rotateSessionTokenIfCurrent(generation, previousToken, token))) return;
  } catch (error) {
    unsavedPasswordChange = submission;
    // The replacement is already in memory; resume before the keychain error reaches the UI.
    await maybeResume();
    throw error;
  }
  await maybeResume();
}
export async function signOut() {
  const apiBase = currentApiBase();
  // A save still running reads as no session, and the clear would delete its token once it lands
  // with no record to revoke it: as in a server switch, the sign-out stops and the user retries.
  if (sessionSaveInProgress()) throw new Error(t`Could not clear the local session`);
  const generation = currentSessionGeneration();
  const tokenSnapshot = await snapshotSessionToken();
  if (!tokenSnapshot.ok) throw new Error(t`Could not clear the local session`);
  // A failed save or wipe can leave a token stored that reads as no session; the clear deletes it
  // too. An unreadable store only skips that record: signing out still clears this device.
  const stored = tokenSnapshot.value ? undefined : await snapshotStoredSessionToken();
  // A sign-in that started during the first read may have stored its token by the second one;
  // that token is the session in use, not the one being signed out.
  if (stored && (generation !== currentSessionGeneration() || sessionSaveInProgress())) {
    throw new Error(t`Could not clear the local session`);
  }
  const revocation: PendingSignOut = {
    apiBase,
    token: tokenSnapshot.value || (stored?.ok ? stored.value : ""),
    headers: serverHeaders(apiBase),
    recordedAt: Date.now(),
  };
  // The record is written before the attempts: an app that dies mid-sign-out still revokes later.
  // A failed write cannot block the local sign-out; the session still expires server-side.
  const persisted = revocation.token ? await savePendingSignOut(revocation) : false;
  // A sign-in that saved its token since the read has no record; as in a server switch, the
  // sign-out stops without clearing it. The record stays for the session the user signed out of.
  if (generation !== currentSessionGeneration() || sessionSaveInProgress()) {
    throw new Error(t`Could not clear the local session`);
  }
  // The local session clears first: a server that accepts the connection but never answers
  // must not keep this device signed in for the delivery's request timeout.
  const sessionCleared = await clearSessionToken();
  const spaceCleared = await clearSpace();
  if (!sessionCleared || !spaceCleared) throw new Error(t`Could not clear the local session`);
  // Delivery waits on the same silent server, so it cannot hold the visible sign-out either.
  // The persisted record covers an attempt that dies with the process.
  if (revocation.token) void deliverSignOutRecord(revocation, persisted);
}
export async function deleteAccount(password?: string, token?: string) {
  // No push unregistration: deleting the user removes the registrations on the server,
  // and unregistering first would silently end this device's notifications and calls
  // whenever the deletion is refused (wrong password, throttling, server error).
  const { response, body, invalidJson } = await fetchMobileJson<unknown>(
    `${currentApiBase()}/api/auth/delete-user`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "rakazo://",
        ...(await authHeaders()),
      },
      body: JSON.stringify({ password, token }),
    },
    {},
  );
  if (!response.ok) {
    throw new Error(
      authResponseErrorText(response.status, body, invalidJson, t`Could not delete account`),
    );
  }
  await clearSessionToken();
  await clearSpace();
}
export async function fetchAccountSecurity(): Promise<AccountSecurity> {
  const { response, body } = await fetchMobileJson<unknown>(
    `${currentApiBase()}/api/auth/account-security`,
    { headers: { origin: "rakazo://", ...(await authHeaders()) } },
    null,
  );
  // Older servers support password accounts and the original change/delete endpoints.
  if (response.status === 404) return legacyAccountSecurity;
  if (!response.ok) throw new Error(t`Could not load sign-in options`);
  try {
    return accountSecuritySchema.parse(body);
  } catch {
    throw new Error(t`Could not load sign-in options`);
  }
}
async function postSignedInAuth(path: string, payload: Record<string, string> = {}): Promise<void> {
  const { response, body, invalidJson } = await fetchMobileJson<unknown>(
    `${currentApiBase()}/api/auth${path}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "rakazo://",
        ...(await authHeaders()),
      },
      body: JSON.stringify(payload),
    },
    null,
  );
  if (!response.ok)
    throw new Error(
      authResponseErrorText(response.status, body, invalidJson, t`Could not continue`),
    );
}
export const requestAccountDeletionCode = () => postSignedInAuth("/request-account-deletion");
/** Emails a confirmation code to an account without a password. */
export const requestIdentityCode = () => postSignedInAuth("/request-identity-code");
/** Confirms this session's identity for the next few minutes. */
export const confirmIdentity = (proof: { password: string } | { code: string }) =>
  postSignedInAuth("/confirm-identity", proof);
