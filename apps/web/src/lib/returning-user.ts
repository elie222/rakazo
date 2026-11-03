/** Set once a session is seen, so a signed-out return to `/` opens sign-in instead of sign-up. */
export const SIGNED_IN_BEFORE_KEY = "rakazo.signed-in-before";

export function hasSignedInBefore(): boolean {
  try {
    return window.localStorage.getItem(SIGNED_IN_BEFORE_KEY) === "1";
  } catch {
    return false;
  }
}

export function rememberSignedIn(): void {
  try {
    window.localStorage.setItem(SIGNED_IN_BEFORE_KEY, "1");
  } catch {
    // Private mode / blocked storage: new visitors and returning ones both land on sign-up.
  }
}
