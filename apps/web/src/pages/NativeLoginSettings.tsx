import { Trans, useLingui } from "@lingui/react/macro";
import type { NativeLoginAccount, NativeLoginList } from "@rakazo/contracts";
import { EXECUTION_HARNESS_LABELS, isNativeLoginVerificationUri } from "@rakazo/contracts";
import { createNativeLoginMonitor } from "@rakazo/core";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Input,
  NativeSelect,
  NativeSelectOption,
  Switch,
} from "@rakazo/ui-web";
import { useEffect, useId, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";

export function NativeLoginSettings() {
  const { t } = useLingui();
  const ids = useId();
  const [data, setData] = useState<NativeLoginList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [harness, setHarness] = useState<"codex" | "kimi">("codex");
  const [label, setLabel] = useState("");
  const [computerId, setComputerId] = useState("");
  const [credentialId, setCredentialId] = useState<string>();
  const [region, setRegion] = useState<"global" | "mainland-cn">("global");
  const [attested, setAttested] = useState(false);
  const [pending, setPending] = useState(false);
  const [logoutTarget, setLogoutTarget] = useState<NativeLoginAccount | null>(null);
  const active = useRef(true);
  const requestPending = useRef(false);
  const monitors = useRef(new Map<string, ReturnType<typeof createNativeLoginMonitor>>());
  function update(account: NativeLoginAccount) {
    if (!active.current) return;
    setData((current) =>
      current
        ? {
            ...current,
            accounts: [
              ...current.accounts.filter((entry) => entry.credentialId !== account.credentialId),
              account,
            ],
          }
        : current,
    );
  }
  function watch(account: NativeLoginAccount) {
    monitors.current.get(account.credentialId)?.stop();
    const monitor = createNativeLoginMonitor({
      status: (credentialId) => rpc.nativeLogins.status({ credentialId }),
      onUpdate: update,
      onError: () => {
        if (active.current) setError(t`Could not check sign-in. Try reconnecting.`);
      },
    });
    monitors.current.set(account.credentialId, monitor);
    monitor.start(account);
  }
  useEffect(() => {
    active.current = true;
    void rpc.nativeLogins
      .list()
      .then((result) => {
        if (!active.current) return;
        setData(result);
        if (result.computers.length === 1) setComputerId(result.computers[0]!.id);
        for (const account of result.accounts) watch(account);
      })
      .catch(() => {
        if (active.current) setError(t`Could not load signed-in accounts`);
      });
    return () => {
      active.current = false;
      for (const monitor of monitors.current.values()) monitor.stop();
    };
  }, []);
  async function begin() {
    if (!attested || !label.trim() || !computerId || requestPending.current) return;
    requestPending.current = true;
    setPending(true);
    setError(null);
    try {
      const account = await rpc.nativeLogins.begin({
        harness,
        computerId,
        label: label.trim(),
        region,
        ...(credentialId ? { credentialId } : {}),
        selfHostedPersonalUse: true,
      });
      if (!active.current) return;
      update(account);
      watch(account);
      setEditing(false);
      setAttested(false);
    } catch (err) {
      if (active.current) setError(errorText(err, t`Could not start sign-in`));
    } finally {
      requestPending.current = false;
      if (active.current) setPending(false);
    }
  }
  async function end(account: NativeLoginAccount, action: "cancel" | "logout") {
    if (requestPending.current) return;
    monitors.current.get(account.credentialId)?.stop();
    requestPending.current = true;
    setPending(true);
    setError(null);
    try {
      update(await rpc.nativeLogins[action]({ credentialId: account.credentialId }));
    } catch (err) {
      if (active.current) setError(errorText(err, t`Could not disconnect account`));
    } finally {
      requestPending.current = false;
      if (active.current) {
        setPending(false);
        setLogoutTarget(null);
      }
    }
  }
  function edit(account?: NativeLoginAccount) {
    setHarness(account?.harness ?? "codex");
    setLabel(account?.label ?? "");
    setCredentialId(account?.credentialId);
    setComputerId(
      account?.computerId ?? (data?.computers.length === 1 ? data.computers[0]!.id : ""),
    );
    setRegion(account?.endpoint.includes("api.kimi.com") ? "mainland-cn" : "global");
    setAttested(false);
    setEditing(true);
    setError(null);
  }
  if (!data)
    return error ? (
      <p role="alert" className="mt-3 text-[13px] text-destructive">
        {error}
      </p>
    ) : null;
  if (!data.enabled && !data.accounts.length) return null;
  const logoutName = logoutTarget?.label ?? "";
  return (
    <details className="mt-6 border-t border-border pt-5" data-testid="native-login-settings">
      <summary className="cursor-pointer text-sm">
        <Trans>Native sign-in</Trans>
      </summary>
      {data.accounts.map((account) => (
        <div key={account.credentialId} className="mt-4 text-[13px]">
          <p className="font-medium">
            {account.label} · {EXECUTION_HARNESS_LABELS[account.harness]}
          </p>
          {account.state.state === "pending" ? (
            <>
              <p className="mt-1 text-muted-foreground">
                <Trans>Finish signing in in your browser:</Trans>
              </p>
              {isNativeLoginVerificationUri(account.harness, account.state.verificationUri) ? (
                <a
                  href={account.state.verificationUri}
                  target="_blank"
                  rel="noreferrer"
                  className="break-all underline"
                >
                  {account.state.verificationUri}
                </a>
              ) : (
                <p role="alert">
                  <Trans>Sign-in page unavailable</Trans>
                </p>
              )}
              <p
                role="status"
                className="my-2 font-mono text-base"
                aria-label={t`Verification code`}
              >
                {account.state.userCode}
              </p>
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => void end(account, "cancel")}
              >
                <Trans>Cancel sign-in</Trans>
              </Button>
            </>
          ) : account.state.state === "ready" ? (
            <>
              <p className="text-muted-foreground">
                {account.state.accountLabel ?? t`Connected`}
                {account.state.plan ? ` · ${account.state.plan}` : ""}
              </p>
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => setLogoutTarget(account)}
              >
                <Trans>Disconnect</Trans>
              </Button>
            </>
          ) : (
            <>
              <p className="text-muted-foreground">
                {account.state.state === "signed_out"
                  ? t`Signed out`
                  : account.state.code === "expired"
                    ? t`Sign-in expired`
                    : t`Sign-in did not complete`}
              </p>
              <Button
                variant="ghost"
                size="sm"
                disabled={pending || !data.enabled}
                onClick={() => edit(account)}
              >
                <Trans>Reconnect</Trans>
              </Button>
              {account.state.state === "failed" ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() => setLogoutTarget(account)}
                >
                  <Trans>Disconnect</Trans>
                </Button>
              ) : null}
            </>
          )}
        </div>
      ))}
      {data.enabled && !editing ? (
        <Button
          className="mt-3"
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => edit()}
        >
          <Trans>Add signed-in account</Trans>
        </Button>
      ) : data.enabled ? (
        <fieldset disabled={pending} className="mt-4 space-y-3">
          <label htmlFor={`${ids}-harness`} className="block text-[13px]">
            <Trans>Harness</Trans>
            <NativeSelect
              id={`${ids}-harness`}
              className="mt-1 w-full"
              value={harness}
              disabled={Boolean(credentialId)}
              onChange={(event) => setHarness(event.target.value as "codex" | "kimi")}
            >
              <NativeSelectOption value="codex">Codex</NativeSelectOption>
              <NativeSelectOption value="kimi">Kimi Code</NativeSelectOption>
            </NativeSelect>
          </label>
          <label htmlFor={`${ids}-name`} className="block text-[13px]">
            <Trans>Account name</Trans>
            <Input
              id={`${ids}-name`}
              className="mt-1"
              value={label}
              maxLength={80}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          <label htmlFor={`${ids}-computer`} className="block text-[13px]">
            <Trans>Computer</Trans>
            <NativeSelect
              id={`${ids}-computer`}
              className="mt-1 w-full"
              value={computerId}
              onChange={(event) => setComputerId(event.target.value)}
            >
              <NativeSelectOption value="">{t`Choose computer`}</NativeSelectOption>
              {data.computers.map((computer) => (
                <NativeSelectOption key={computer.id} value={computer.id}>
                  {computer.scope === "team"
                    ? t`Team computer`
                    : (computer.botName ?? t`Private computer`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          {!data.computers.length ? (
            <p className="text-[13px] text-muted-foreground">
              <Trans>An available Linux Docker computer is required.</Trans>
            </p>
          ) : null}
          {harness === "kimi" ? (
            <>
              <label htmlFor={`${ids}-region`} className="block text-[13px]">
                <Trans>Region</Trans>
                <NativeSelect
                  id={`${ids}-region`}
                  className="mt-1 w-full"
                  value={region}
                  onChange={(event) => setRegion(event.target.value as "global" | "mainland-cn")}
                >
                  <NativeSelectOption value="global">{t`Global`}</NativeSelectOption>
                  <NativeSelectOption value="mainland-cn">{t`Mainland China`}</NativeSelectOption>
                </NativeSelect>
              </label>
              <p className="text-[13px] text-muted-foreground">
                <Trans>Personal interactive chats only.</Trans>
              </p>
            </>
          ) : null}
          <label
            htmlFor={`${ids}-attested`}
            className="flex items-center justify-between gap-3 text-[13px]"
          >
            <Trans>This is my personal, self-hosted deployment.</Trans>
            <Switch
              id={`${ids}-attested`}
              aria-label={t`This is my personal, self-hosted deployment.`}
              checked={attested}
              onCheckedChange={setAttested}
            />
          </label>
          <div className="flex gap-2">
            <Button
              disabled={!attested || !computerId || !label.trim() || pending}
              onClick={() => void begin()}
            >
              <Trans>Sign in</Trans>
            </Button>
            <Button variant="ghost" onClick={() => setEditing(false)}>
              <Trans>Cancel</Trans>
            </Button>
          </div>
        </fieldset>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
      <AlertDialog
        open={Boolean(logoutTarget)}
        onOpenChange={(open) => {
          if (!open && !pending) setLogoutTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t`Disconnect ${logoutName}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>Removes this sign-in from Rakazo. Provider sessions may remain active.</Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={() => logoutTarget && void end(logoutTarget, "logout")}
            >
              <Trans>Disconnect</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </details>
  );
}
