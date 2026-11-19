import { Trans, useLingui } from "@lingui/react/macro";
import type {
  ModelAccountConfig,
  ModelAccountErrorCode,
  ModelAccountStatus,
} from "@rakazo/contracts";
import { modelAccountErrorCodeSchema } from "@rakazo/contracts";
import {
  createModelAccountClient,
  ModelAccountClientError,
  resolveAccountNavigation,
} from "@rakazo/core";
import {
  Button,
  SectionHeading,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
} from "@rakazo/ui-web";
import { useQueryClient } from "@tanstack/react-query";
import type { MouseEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { authClient } from "../lib/auth/auth";
import { cancelSsoFlow, runSsoFlow } from "../lib/auth/sso-flow";
import { desktopBridge } from "../lib/platform/desktop";
import { authErrorText } from "../lib/query/user-error";
import { AccountI18n } from "../pages/model-account/AccountI18n";
import { AUTHORIZATION_RETURN_PARAM } from "../pages/model-account/use-authorization-return";

const client = createModelAccountClient();
function ModelAccountContent({
  required = false,
  onChanged,
}: {
  required?: boolean;
  onChanged?: () => void | Promise<void>;
}) {
  const { t } = useLingui();
  const name = "SSO";
  const navigate = useNavigate();
  const userId = authClient.useSession().data?.user.id;
  const queries = useQueryClient();
  const [config, setConfig] = useState<ModelAccountConfig>();
  const [status, setStatus] = useState<ModelAccountStatus>();
  const [balance, setBalance] = useState<string>();
  const [error, setError] = useState<ModelAccountErrorCode>();
  const [identityError, setIdentityError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const actionAbort = useRef<AbortController | null>(null);
  const refresh = useCallback(
    async (signal?: AbortSignal, includeBalance = true) => {
      const latest = await client.status(signal);
      if (signal?.aborted) return;
      setStatus(latest);
      if (latest.linked) setIdentityError(undefined);
      if (
        latest.connected &&
        latest.recovery !== "authorization_unknown" &&
        latest.recovery !== "revocation_unknown"
      )
        setError((previous) => (previous === "result_unknown" ? undefined : previous));
      if (latest.linked === false || !latest.connected || latest.recovery) {
        setBalance(undefined);
        return;
      }
      if (!includeBalance) return;
      try {
        const value = await client.balance(signal);
        if (!signal?.aborted) setBalance(`${value.amount} ${value.unit}`);
      } catch {
        if (!signal?.aborted) setBalance(t`Balance unavailable`);
      }
    },
    [t],
  );
  useEffect(() => {
    const abort = new AbortController();
    setBusy(false);
    setAuthorizing(false);
    setConfig(undefined);
    setStatus(undefined);
    setBalance(undefined);
    setIdentityError(undefined);
    setError(
      modelAccountErrorCodeSchema.safeParse(
        new URL(window.location.href).searchParams.get("modelAccountError"),
      ).data,
    );
    const update = () => {
      if (document.visibilityState === "hidden") return;
      void client
        .config(abort.signal)
        .then(async (value) => {
          if (abort.signal.aborted) return;
          setConfig(value);
          if (value.enabled) await refresh(abort.signal);
        })
        .catch((error) => {
          if (!abort.signal.aborted)
            setError(error instanceof ModelAccountClientError ? error.code : "unavailable");
        });
    };
    update();
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      abort.abort();
      actionAbort.current?.abort();
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [userId, refresh, attempt]);
  if (!config?.enabled)
    return required ? (
      <div className="space-y-4">
        {config || error ? (
          <p role="alert" className="text-body text-destructive">
            <Trans>Model account unavailable</Trans>
          </p>
        ) : (
          <p role="status" className="flex items-center gap-2 text-body text-muted-foreground">
            <Spinner aria-hidden />
            <Trans>Checking authorization…</Trans>
          </p>
        )}
        {error ? (
          <Button className="min-h-11" onClick={() => setAttempt((value) => value + 1)}>
            <Trans>Retry</Trans>
          </Button>
        ) : null}
      </div>
    ) : null;
  const navigation = resolveAccountNavigation(config, document.cookie, window.location.hostname);
  const serviceName = config.serviceName ?? t`model service`;
  const updateNavigationLink =
    (kind: "homeUrl" | "rechargeUrl") => (event: MouseEvent<HTMLAnchorElement>) => {
      const latest = resolveAccountNavigation(config, document.cookie, window.location.hostname);
      if (!latest) event.preventDefault();
      else event.currentTarget.href = latest[kind];
    };
  const act = async (
    kind: "connect" | "revoke" | "refresh" | "models" | "protocol" | "identity",
    protocol?: "chat-completions" | "responses",
  ) => {
    const abort = new AbortController();
    actionAbort.current = abort;
    setBusy(true);
    setError(undefined);
    setIdentityError(undefined);
    try {
      if (kind === "identity") {
        setAuthorizing(Boolean(desktopBridge()));
        const returnTo = window.location.href;
        const result = await runSsoFlow(
          (disableRedirect, callbackURL) =>
            authClient.linkSocial({
              provider: "oidc",
              disableRedirect,
              callbackURL: callbackURL(returnTo),
              errorCallbackURL: callbackURL(returnTo),
            }),
          [returnTo],
          { navigate: false, signal: abort.signal },
        );
        if (result.error) throw new Error(authErrorText(result.error, t`Could not continue`));
        if (!desktopBridge() && result.data?.url) {
          window.location.assign(result.data.url);
          return;
        }
      } else if (kind === "protocol" && protocol) await client.settings(protocol, abort.signal);
      else if (kind === "models") await client.refreshModels(abort.signal);
      else if (kind === "revoke") await client.revoke(abort.signal);
      else if (kind !== "refresh") {
        const returnURL = new URL(window.location.href);
        returnURL.searchParams.delete("modelAccountError");
        if (returnURL.href !== window.location.href)
          navigate(`${returnURL.pathname}${returnURL.search}${returnURL.hash}`, { replace: true });
        returnURL.searchParams.set(AUTHORIZATION_RETURN_PARAM, "1");
        const returnTo = returnURL.href;
        if (!desktopBridge()) {
          const connected = await client.connect(returnTo, abort.signal);
          abort.signal.throwIfAborted();
          if (connected.url) {
            window.location.assign(connected.url);
            return;
          }
        } else {
          setAuthorizing(true);
          const result = await runSsoFlow(
            async (_disableRedirect, callbackURL) => {
              const connected = await client.connect(callbackURL(returnTo), abort.signal);
              return { data: { url: connected.url }, error: null };
            },
            [returnTo],
            { navigate: false, signal: abort.signal },
          );
          if (result.error) {
            const code = modelAccountErrorCodeSchema.safeParse(result.error.code);
            throw new ModelAccountClientError(code.success ? code.data : "unavailable");
          }
        }
      }
      abort.signal.throwIfAborted();
      await refresh(abort.signal, kind === "refresh");
      await queries.invalidateQueries();
      await onChanged?.();
    } catch (cause) {
      if (abort.signal.aborted) return;
      if (kind === "identity") setIdentityError(authErrorText(cause, t`Could not continue`));
      setError(cause instanceof ModelAccountClientError ? cause.code : "unavailable");
      await refresh(abort.signal).catch(() => undefined);
    } finally {
      if (!abort.signal.aborted) {
        setBusy(false);
        setAuthorizing(false);
      }
      if (actionAbort.current === abort) actionAbort.current = null;
    }
  };
  const identityUnavailable = status?.linked === false || error === "link_required";
  const setup =
    !status?.connected ||
    Boolean(status.recovery) ||
    identityUnavailable ||
    error === "authorization_required";
  const message =
    identityError ??
    (status?.recovery === "revocation_unknown"
      ? t`Disconnection pending confirmation.`
      : identityUnavailable
        ? t`Sign in with SSO to use the model account.`
        : error && error !== "authorization_required" && error !== "result_unknown"
          ? t`Model account unavailable`
          : error === "authorization_required" || status?.recovery === "authorization_required"
            ? t`Authorize the model account to continue.`
            : error === "result_unknown" || status?.recovery === "authorization_unknown"
              ? t`Could not confirm authorization. Try again.`
              : status?.recovery === "authorization_pending"
                ? authorizing
                  ? t`Complete authorization in the opened window.`
                  : t`Authorization incomplete.`
                : error
                  ? t`Model account unavailable`
                  : null);

  if (!status)
    return (
      <div className="space-y-4" aria-live="polite">
        {error ? (
          <>
            <p role="alert" className="text-body text-destructive">
              <Trans>Model account unavailable</Trans>
            </p>
            <Button className="min-h-11" onClick={() => setAttempt((value) => value + 1)}>
              <Trans>Retry</Trans>
            </Button>
          </>
        ) : (
          <p role="status" className="flex items-center gap-2 text-body text-muted-foreground">
            <Spinner aria-hidden />
            <Trans>Checking authorization…</Trans>
          </p>
        )}
      </div>
    );
  return (
    <section className={setup ? "space-y-4" : "mb-6 space-y-3"} data-model-account>
      {!setup ? (
        <SectionHeading>
          <Trans>Model account</Trans>
        </SectionHeading>
      ) : null}
      {status?.connected && !message ? (
        <p role="status" className="text-body">
          <Trans>Connected</Trans>
        </p>
      ) : null}
      {!setup && balance ? <p className="text-body text-muted-foreground">{balance}</p> : null}
      {setup ? (
        <div className="space-y-3 text-body leading-6">
          <p>
            <Trans>
              After authorization, this app will use your {serviceName} account to call models.
              Model usage is charged to your {serviceName} account balance.
            </Trans>
          </p>
          <p className="text-label text-muted-foreground">
            <Trans>You will return to the app after authorization.</Trans>
          </p>
        </div>
      ) : null}
      {message ? (
        <p
          role={error ? "alert" : "status"}
          className={error ? "text-body text-destructive" : "text-body text-muted-foreground"}
        >
          {message}
        </p>
      ) : null}
      {!setup && status.connected ? (
        <Select
          value={status.apiProtocol ?? "chat-completions"}
          items={[
            { value: "chat-completions", label: "Chat Completions" },
            { value: "responses", label: "Responses" },
          ]}
          onValueChange={(value) => {
            if (value !== "chat-completions" && value !== "responses") return;
            void act("protocol", value);
          }}
          disabled={busy}
        >
          <SelectTrigger aria-label={t`API protocol`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="chat-completions">Chat Completions</SelectItem>
            <SelectItem value="responses">Responses</SelectItem>
          </SelectContent>
        </Select>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {identityUnavailable ? (
          <Button
            className="min-h-11 w-full sm:w-auto"
            aria-busy={busy}
            disabled={busy}
            onClick={() => void act("identity")}
          >
            {busy ? <Spinner aria-hidden /> : null}
            <Trans>Continue with {name}</Trans>
          </Button>
        ) : null}
        {!identityUnavailable &&
        status?.recovery !== "revocation_unknown" &&
        (!status?.connected ||
          error === "authorization_required" ||
          status?.recovery === "authorization_required" ||
          status?.recovery) ? (
          <Button
            size="sm"
            className="min-h-11 w-full sm:w-auto"
            aria-busy={busy}
            disabled={busy}
            onClick={() =>
              void act(status?.recovery === "authorization_unknown" ? "refresh" : "connect")
            }
          >
            {busy ? (
              <>
                <Spinner aria-hidden />
                <Trans>Authorizing…</Trans>
              </>
            ) : error === "authorization_required" ||
              status?.recovery === "authorization_required" ? (
              <Trans>Authorize again</Trans>
            ) : status?.recovery === "authorization_unknown" || error === "result_unknown" ? (
              <Trans>Retry</Trans>
            ) : status?.recovery === "authorization_pending" ? (
              <Trans>Authorize again</Trans>
            ) : (
              <Trans>Agree and authorize</Trans>
            )}
          </Button>
        ) : null}
        {!setup && status.connected ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act("models")}>
            <Trans>Refresh models</Trans>
          </Button>
        ) : null}
        {authorizing ? (
          <Button size="sm" variant="outline" onClick={cancelSsoFlow}>
            <Trans>Cancel</Trans>
          </Button>
        ) : null}
        {status?.recovery === "revocation_unknown" ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void act("revoke")}>
            <Trans>Retry disconnect</Trans>
          </Button>
        ) : null}
        {!setup ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act("refresh")}>
            <Trans>Refresh balance</Trans>
          </Button>
        ) : null}
        {!setup && navigation ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              nativeButton={false}
              role="link"
              render={
                <a
                  href={navigation.homeUrl}
                  target="_blank"
                  rel="noreferrer"
                  onClick={updateNavigationLink("homeUrl")}
                  onAuxClick={updateNavigationLink("homeUrl")}
                />
              }
            >
              <Trans>Home</Trans>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              nativeButton={false}
              role="link"
              render={
                <a
                  href={navigation.rechargeUrl}
                  target="_blank"
                  rel="noreferrer"
                  onClick={updateNavigationLink("rechargeUrl")}
                  onAuxClick={updateNavigationLink("rechargeUrl")}
                />
              }
            >
              <Trans>Recharge</Trans>
            </Button>
          </>
        ) : null}
      </div>
    </section>
  );
}

export function ModelAccount(props: Parameters<typeof ModelAccountContent>[0]) {
  return (
    <AccountI18n>
      <ModelAccountContent {...props} />
    </AccountI18n>
  );
}
