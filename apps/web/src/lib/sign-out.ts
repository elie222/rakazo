import { t } from "@lingui/core/macro";
import { useEffect, useRef, useState } from "react";
import { authClient } from "./auth";
import { endCallBeforeSignOut, forgetSignedInUser, sessionChangedUnderPage } from "./call-session";
import { clearSpaceSelection } from "./rpc";

/** Kept across the reload after a failed sign-out, so the fresh page can say it failed. */
export const LOG_OUT_FAILED_KEY = "rakazo.logOutFailed";
/** The reload after a failed sign-out found the user still signed in. */
let logOutFailed = false;

/**
 * Signs out, then loads a fresh page whether or not it worked, so no call, microphone, pending
 * answer or queued request from this session survives in the page.
 */
export async function signOut(destination: string): Promise<void> {
  // Hang up while the session still exists, so the server-side hang-up is authorized.
  await endCallBeforeSignOut();
  // The account changed while hanging up: signing out now would sign out the other account.
  if (sessionChangedUnderPage()) {
    window.location.reload();
    return;
  }
  const result = await authClient.signOut().catch(() => null);
  if (result && !result.error) {
    forgetSignedInUser();
    clearSpaceSelection();
    window.location.assign(destination);
  } else {
    try {
      sessionStorage.setItem(LOG_OUT_FAILED_KEY, "1");
    } catch {
      // No storage: the page still reloads, without the failure message.
    }
    window.location.reload();
  }
}

/**
 * Called once the page knows its session. A failed sign-out is reported only when the fresh page
 * is still signed in; either way the marker is read once.
 */
export function syncLogOutFailure(signedIn: boolean): void {
  try {
    if (sessionStorage.getItem(LOG_OUT_FAILED_KEY) === null) return;
    sessionStorage.removeItem(LOG_OUT_FAILED_KEY);
  } catch {
    return;
  }
  logOutFailed = signedIn;
}

export function useSignOut(destination: string, onError: (message: string) => void) {
  const busy = useRef(false);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    if (!logOutFailed) return;
    logOutFailed = false;
    onError(t`Could not log out. Try again.`);
  }, [onError]);

  async function logOut() {
    if (busy.current) return;
    busy.current = true;
    setSigningOut(true);
    // The page is left either way, so it stays busy until then.
    await signOut(destination);
  }

  return { signingOut, logOut };
}
