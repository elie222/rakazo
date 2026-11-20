import type { ModelCatalogEntry } from "@rakazo/contracts";
import { useState } from "react";

/**
 * Puts a provider's required setting before its sign-in, so the code or link is only
 * issued once the user is ready to use it.
 */
export function useSignInSetup(
  setup: ModelCatalogEntry["signInSetup"],
  provider: string | undefined,
  start: () => void,
) {
  const [shownFor, setShownFor] = useState<string | null>(null);
  return {
    setup: setup && provider && shownFor === provider ? setup : undefined,
    begin: () => (setup && provider ? setShownFor(provider) : start()),
    proceed: () => {
      setShownFor(null);
      start();
    },
    dismiss: () => setShownFor(null),
  };
}
