import { Trans, useLingui } from "@lingui/react/macro";
import type { ServiceCredential, ServiceScope } from "@rakazo/contracts";
import { isIdentityConfirmationRequired, SERVICE_SCOPES } from "@rakazo/contracts";
import { Button, Input, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useCopyText } from "../lib/copy-text";
import { useSpaceQueries } from "../lib/query";
import { useSpaceRpc } from "../lib/space-rpc";
import { errorText } from "../lib/user-error";
import { useIdentityConfirmation } from "./ConfirmIdentityDialog";

const EXPIRY_DAYS = [30, 90, 365] as const;

/** Keys that let a program work with this person's bots in the bound Space. */
export function ServiceKeysSettings() {
  const { t } = useLingui();
  const ids = useId();
  const rpc = useSpaceRpc();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const list = queries.serviceCredentials.list.queryOptions();
  const { data: keys, isError: loadFailed } = useQuery({ ...list, refetchOnMount: "always" });
  const { data: bots } = useQuery(queries.bots.list.queryOptions());
  const { withIdentityConfirmation, identityDialog } = useIdentityConfirmation();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ServiceScope[]>(["bots:read"]);
  const [days, setDays] = useState<number>(90);
  const [botIds, setBotIds] = useState<string[]>([]);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, copy] = useCopyText();

  const refresh = () => queryClient.invalidateQueries({ queryKey: list.queryKey });

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const created = await withIdentityConfirmation(() =>
        rpc.serviceCredentials.create({ name, scopes, botIds, expiresInDays: days }),
      );
      setToken(created.token);
      setName("");
      setBotIds([]);
      await refresh();
    } catch (err) {
      // Closing the confirmation is a choice, not a failure.
      if (!isIdentityConfirmationRequired(err)) {
        setError(errorText(err, t`Could not create the key`));
      }
    } finally {
      setBusy(false);
    }
  }

  async function revoke(key: ServiceCredential) {
    setBusy(true);
    setError(null);
    try {
      await rpc.serviceCredentials.revoke({ id: key.id });
      setToken(null);
      await refresh();
    } catch (err) {
      setError(errorText(err, t`Could not revoke the key`));
    } finally {
      setBusy(false);
    }
  }

  function expiryText(key: ServiceCredential) {
    const date = new Date(key.expiresAt).toLocaleDateString();
    return new Date(key.expiresAt).getTime() <= Date.now()
      ? t`Expired ${date}`
      : t`Expires ${date}`;
  }

  return (
    <div className="space-y-4">
      {identityDialog}
      <p className="text-body text-muted-foreground">
        <Trans>Keys let a program read your bots and send them prompts as you.</Trans>
      </p>
      {token ? (
        <div className="space-y-2 rounded-md border border-border p-3">
          <p className="text-body">
            <Trans>Copy this key now. It won't be shown again.</Trans>
          </p>
          <code className="block break-all text-body-sm">{token}</code>
          <Button type="button" variant="outline" size="sm" onClick={() => copy(token)}>
            {copied ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
          </Button>
        </div>
      ) : null}
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <label className="block text-body text-muted-foreground" htmlFor={`${ids}-name`}>
          <Trans>Name</Trans>
        </label>
        <Input
          id={`${ids}-name`}
          value={name}
          maxLength={60}
          onChange={(event) => setName(event.target.value)}
        />
        <fieldset className="grid grid-cols-2 gap-1">
          <legend className="text-body text-muted-foreground">
            <Trans>What this key can do</Trans>
          </legend>
          {SERVICE_SCOPES.map((scope) => (
            <label key={scope} className="flex items-center gap-2 text-body">
              <input
                type="checkbox"
                checked={scopes.includes(scope)}
                onChange={(event) =>
                  setScopes((current) =>
                    event.target.checked
                      ? [...current, scope]
                      : current.filter((entry) => entry !== scope),
                  )
                }
              />
              {scope}
            </label>
          ))}
        </fieldset>
        {bots?.length ? (
          <fieldset className="space-y-1">
            <legend className="text-body text-muted-foreground">
              <Trans>Limit to these bots, or leave empty for all</Trans>
            </legend>
            {bots.map((bot) => (
              <label key={bot.id} className="flex items-center gap-2 text-body">
                <input
                  type="checkbox"
                  checked={botIds.includes(bot.id)}
                  onChange={(event) =>
                    setBotIds((current) =>
                      event.target.checked
                        ? [...current, bot.id]
                        : current.filter((id) => id !== bot.id),
                    )
                  }
                />
                {bot.name}
              </label>
            ))}
          </fieldset>
        ) : null}
        <label className="block text-body text-muted-foreground" htmlFor={`${ids}-days`}>
          <Trans>Expires after</Trans>
        </label>
        <NativeSelect
          id={`${ids}-days`}
          value={String(days)}
          onChange={(event) => setDays(Number(event.target.value))}
        >
          {EXPIRY_DAYS.map((value) => (
            <NativeSelectOption key={value} value={String(value)}>
              {t`${value} days`}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Button type="submit" disabled={busy || !name.trim() || scopes.length === 0}>
          <Trans>Create key</Trans>
        </Button>
      </form>
      {error ? (
        <p role="alert" className="text-body text-destructive">
          {error}
        </p>
      ) : null}
      {loadFailed ? (
        <p role="alert" className="text-body text-destructive">
          <Trans>Could not load your keys</Trans>
        </p>
      ) : null}
      <ul className="divide-y divide-border">
        {keys?.map((key) => (
          <li key={key.id} className="flex items-center justify-between gap-3 py-2">
            <div className="min-w-0 text-body">
              <div className="truncate">{key.name}</div>
              <div className="truncate text-muted-foreground">
                {key.tokenPrefix}… {key.scopes.join(", ")}
              </div>
              <div className="truncate text-muted-foreground">{expiryText(key)}</div>
            </div>
            {key.revokedAt ? (
              <span className="text-body text-muted-foreground">
                <Trans>Revoked</Trans>
              </span>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void revoke(key)}
              >
                <Trans>Revoke</Trans>
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
