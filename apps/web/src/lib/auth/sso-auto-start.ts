/**
 * Set when sign-in starts SSO by itself or someone signs out, in any tab, so sign-in waits for a
 * click: Back from the provider stays on sign-in, and the provider's own session cannot sign a
 * person straight back in after they signed out. Cleared once a session is seen.
 */
const SSO_AUTO_START_HELD_KEY = "rakazo.sso-auto-start-held";

export function ssoAutoStartAllowed(): boolean {
  try {
    return window.localStorage.getItem(SSO_AUTO_START_HELD_KEY) === null;
  } catch {
    // Blocked storage cannot remember a sign-out, so sign-in waits for a click.
    return false;
  }
}

/** Whether the hold was saved; an automatic start needs it, or Back would start again. */
export function holdSsoAutoStart(): boolean {
  try {
    window.localStorage.setItem(SSO_AUTO_START_HELD_KEY, "1");
    return true;
  } catch {
    // Full or blocked storage: the caller waits for a click.
    return false;
  }
}

export function releaseSsoAutoStart(): void {
  try {
    window.localStorage.removeItem(SSO_AUTO_START_HELD_KEY);
  } catch {
    // Blocked storage never held the flag.
  }
}
