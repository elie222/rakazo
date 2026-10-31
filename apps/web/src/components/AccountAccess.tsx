import { Trans, useLingui } from "@lingui/react/macro";
import type { AccountSecurity } from "@rakazo/contracts";
import { Button, Input, Label } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { fetchAccountSecurity, requestAccountDeletionCode } from "../lib/account-security";
import { authClient } from "../lib/auth";
import { runSsoFlow } from "../lib/sso-flow";
import { authErrorText } from "../lib/user-error";
import { SettingsRow } from "./SettingsRows";

export function AccountAccess({
  onSecurity,
}: {
  onSecurity?: (security: AccountSecurity) => void;
}) {
  const { t } = useLingui();
  const [security, setSecurity] = useState<AccountSecurity | null>(null);
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(() => {
    const code = redirectError("delete");
    return code ? authErrorText({ code }, t`Could not continue`) : null;
  });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void fetchAccountSecurity()
      .then((value) => {
        if (active) {
          setSecurity(value);
          onSecurity?.(value);
        }
      })
      .catch(() => {
        if (active) setError(t`Could not continue`);
      });
    return () => {
      active = false;
    };
  }, [attempt, onSecurity]);
  async function action(run: () => Promise<unknown>, sso = false) {
    if (!sso) setPending(true);
    setError(null);
    try {
      await run();
    } catch (error) {
      setError(error instanceof Error ? error.message : t`Could not continue`);
    } finally {
      if (!sso) setPending(false);
    }
  }
  return (
    <SettingsRow
      label={<Trans>Delete account</Trans>}
      control={
        <Button
          variant="secondary"
          size="sm"
          data-testid="delete-account"
          className="text-destructive hover:text-destructive"
          onClick={() => setOpen((value) => !value)}
        >
          <Trans>Delete</Trans>
        </Button>
      }
    >
      {open ? (
        <div className="mt-3 space-y-3">
          <p className="text-sm">
            <Trans>This permanently deletes your account and data.</Trans>
          </p>
          {!security ? (
            <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>
              <Trans>Retry</Trans>
            </Button>
          ) : security.hasPassword ? (
            <div>
              <Label htmlFor="delete-password">
                <Trans>Current password</Trans>
              </Label>
              <Input
                id="delete-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
          ) : (
            <>
              {security.sso ? (
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    void action(async () => {
                      const returnTo = ssoReturnURL(false);
                      const result = await runSsoFlow(
                        (disableRedirect, callbackURL) =>
                          authClient.signIn.social({
                            disableRedirect,
                            provider: "oidc",
                            additionalData: { reauthenticate: true },
                            callbackURL: callbackURL(returnTo),
                            errorCallbackURL: callbackURL(returnTo),
                          }),
                        [returnTo],
                      );
                      if (result.error)
                        throw new Error(authErrorText(result.error, t`Could not continue`));
                    }, true)
                  }
                >
                  <Trans>Sign in again</Trans>
                </Button>
              ) : null}
              {security.emailDeletion ? (
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    void action(async () => {
                      await requestAccountDeletionCode();
                      setSent(true);
                    })
                  }
                >
                  <Trans>Send deletion code</Trans>
                </Button>
              ) : null}
              {sent ? (
                <div>
                  <Label htmlFor="deletion-code">
                    <Trans>Deletion code</Trans>
                  </Label>
                  <Input
                    id="deletion-code"
                    autoComplete="one-time-code"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                  />
                </div>
              ) : null}
            </>
          )}
          <Button
            variant="destructive"
            disabled={
              pending ||
              !security ||
              (security.hasPassword && !password) ||
              (!security.hasPassword && !security.freshOidcAuth && !code.trim())
            }
            onClick={() =>
              void action(async () => {
                const current = await fetchAccountSecurity();
                setSecurity(current);
                onSecurity?.(current);
                if (!current.hasPassword && !current.freshOidcAuth && !code.trim()) return;
                if (current.hasPassword && !password) return;
                const result = await authClient.deleteUser(
                  current.hasPassword ? { password } : code.trim() ? { token: code.trim() } : {},
                );
                if (result.error)
                  throw new Error(authErrorText(result.error, t`Could not continue`));
                window.location.assign("/sign-in");
              })
            }
          >
            <Trans>Delete account</Trans>
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-[12.5px] text-destructive">
          {error}
        </p>
      ) : null}
    </SettingsRow>
  );
}

/** Links the organization's SSO identity to an account that signed up another way. */
export function LinkSsoRow() {
  const { t } = useLingui();
  const [error, setError] = useState<string | null>(() => {
    const code = redirectError("link");
    return code ? authErrorText({ code }, t`Could not continue`) : null;
  });
  async function link() {
    setError(null);
    const returnTo = ssoReturnURL(false);
    const failed = ssoReturnURL(true);
    try {
      const result = await runSsoFlow(
        (disableRedirect, callbackURL) =>
          authClient.linkSocial({
            disableRedirect,
            provider: "oidc",
            callbackURL: callbackURL(returnTo),
            errorCallbackURL: callbackURL(failed),
          }),
        [returnTo, failed],
      );
      if (result.error) setError(authErrorText(result.error, t`Could not continue`));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t`Could not continue`);
    }
  }
  return (
    <SettingsRow
      label={<Trans>SSO</Trans>}
      control={
        <Button variant="secondary" size="sm" onClick={() => void link()}>
          <Trans>Link SSO</Trans>
        </Button>
      }
    >
      {error ? (
        <p role="alert" className="mt-2 text-[12.5px] text-destructive">
          {error}
        </p>
      ) : null}
    </SettingsRow>
  );
}

const LINK_RETURN = "sso-link";

/** This page without an earlier redirect's result; a failed link's return is marked as one. */
function ssoReturnURL(failedLink: boolean): string {
  const url = new URL(window.location.href);
  url.searchParams.delete("error");
  url.searchParams.delete(LINK_RETURN);
  if (failedLink) url.searchParams.set(LINK_RETURN, "1");
  return url.href;
}

/** The error an SSO redirect came back with, for the flow that started it. */
function redirectError(flow: "link" | "delete"): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.has(LINK_RETURN) === (flow === "link") ? params.get("error") : null;
}
