import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { useEffect, useRef, useState } from "react";
import { authClient } from "../lib/auth";
import {
  cancelPasskeyRequest,
  conditionalPasskeyAvailable,
  passkeyErrorText,
  usePasskeysSupported,
} from "../lib/passkeys";

/**
 * Passkey sign-in for the sign-in form: a button, plus browser autofill on the
 * email field (`autocomplete="username webauthn"`) where conditional UI exists.
 */
export function PasskeySignIn({
  className,
  disabled,
  onSignedIn,
  onError,
}: {
  className?: string;
  disabled?: boolean;
  onSignedIn: () => void;
  onError: (message: string | null) => void;
}) {
  const { t } = useLingui();
  const supported = usePasskeysSupported();
  const [pending, setPending] = useState(false);
  const callbacks = useRef({ onSignedIn, onError, t });
  callbacks.current = { onSignedIn, onError, t };
  const mounted = useRef(true);

  async function signIn(autoFill: boolean) {
    const result = await authClient.signIn.passkey({ autoFill }).catch((error: unknown) => ({
      data: null,
      error,
    }));
    if (!mounted.current) return;
    const { onSignedIn, onError, t } = callbacks.current;
    if (result.error) {
      const message = passkeyErrorText(result.error, t`Could not continue`);
      if (message) onError(message);
      return;
    }
    onSignedIn();
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Leaving the form (or switching to the code step) must not leave autofill waiting.
      cancelPasskeyRequest();
    };
  }, []);

  useEffect(() => {
    if (!supported) return;
    // Starting another ceremony aborts this one; an unmounted page ignores its result.
    void conditionalPasskeyAvailable().then((available) => {
      if (available && mounted.current) void signIn(true);
    });
  }, [supported]);

  if (!supported) return null;
  return (
    <Button
      type="button"
      variant="outline"
      size="lg"
      disabled={disabled || pending}
      className={className}
      onClick={() => {
        setPending(true);
        onError(null);
        void signIn(false).finally(() => {
          if (mounted.current) setPending(false);
        });
      }}
    >
      <Trans>Sign in with passkey</Trans>
    </Button>
  );
}
