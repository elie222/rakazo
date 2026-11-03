import * as SecureStore from "expo-secure-store";

/** Set once a session is seen, so a signed-out relaunch opens sign-in instead of sign-up. */
export const SIGNED_IN_BEFORE_KEY = "rakazo.signed-in-before";

export async function hasSignedInBefore(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(SIGNED_IN_BEFORE_KEY)) === "1";
  } catch {
    return false;
  }
}

export async function rememberSignedIn(): Promise<void> {
  try {
    await SecureStore.setItemAsync(SIGNED_IN_BEFORE_KEY, "1");
  } catch {
    // SecureStore unavailable in some test / web hosts.
  }
}

/** A deleted account has nothing to sign in to, so the next launch offers sign up again. */
export async function forgetSignedIn(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(SIGNED_IN_BEFORE_KEY);
  } catch {
    // SecureStore unavailable in some test / web hosts.
  }
}
