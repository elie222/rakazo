import { t } from "@lingui/core/macro";
import { useRef, useState } from "react";
import { authClient } from "./auth";

export async function signOut(): Promise<boolean> {
  try {
    const result = await authClient.signOut();
    if (result.error) return false;

    // Ask the server directly: a later shared refresh can supersede the forced one below.
    const check = await authClient.getSession({ query: { disableCookieCache: true } });
    if (check.error || check.data) return false;

    // Refresh the shared session state so navigation does not redirect using stale data.
    await authClient.$store.atoms.session
      ?.get()
      .refetch({ query: { disableCookieCache: true } })
      .catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

export function useSignOut(onSuccess: () => void, onError: (message: string) => void) {
  const busy = useRef(false);
  const [signingOut, setSigningOut] = useState(false);

  async function logOut() {
    if (busy.current) return;
    busy.current = true;
    setSigningOut(true);
    try {
      if (await signOut()) onSuccess();
      else onError(t`Could not log out. Try again.`);
    } finally {
      busy.current = false;
      setSigningOut(false);
    }
  }

  return { signingOut, logOut };
}
