import { Trans, useLingui } from "@lingui/react/macro";
import type { ServiceCredential, ServiceScope } from "@rakazo/contracts";
import { isIdentityConfirmationRequired, SERVICE_SCOPES } from "@rakazo/contracts";
import {
  Button,
  Checkbox,
  Field,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
} from "@rakazo/ui-web";
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
  const { data: bots, isError: botsFailed } = useQuery(queries.bots.list.queryOptions());
  const { withIdentityConfirmation, identityDialog } = useIdentityConfirmation();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ServiceScope[]>(["bots:read"]);
  const [days, setDays] = useState<number>(90);
  const [botIds, setBotIds] = useState<string[]>([]);
  const [created, setCreated] = useState<{ id: string; token: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, copy] = useCopyText();

  const refresh = () => queryClient.invalidateQueries({ queryKey: list.queryKey });

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const result = await withIdentityConfirmation(() =>
        rpc.serviceCredentials.create({ name, scopes, botIds, expiresInDays: days }),
      );
      setCreated({ id: result.credential.id, token: result.token });
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
      // Revoking another key leaves the new one on screen to copy.
      setCreated((current) => (current?.id === key.id ? null : current));
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

  function lastUsedText(key: ServiceCredential) {
    if (!key.lastUsedAt) return t`Never used`;
    const date = new Date(key.lastUsedAt).toLocaleDateString();
    return t`Last used ${date}`;
  }

  return (
    <div className="space-y-4">
      {identityDialog}
      {created ? (
        <div className="space-y-2 rounded-md border border-border p-3">
          <p className="text-body">
            <Trans>Copy this key now. It won't be shown again.</Trans>
          </p>
          <code className="block break-all text-body-sm">{created.token}</code>
          <Button type="button" variant="outline" size="sm" onClick={() => copy(created.token)}>
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
            <Field key={scope} orientation="horizontal">
              <Checkbox
                id={`${ids}-scope-${scope}`}
                checked={scopes.includes(scope)}
                onCheckedChange={(checked) =>
                  setScopes((current) =>
                    checked === true
                      ? [...current, scope]
                      : current.filter((entry) => entry !== scope),
                  )
                }
              />
              <FieldLabel htmlFor={`${ids}-scope-${scope}`}>{scope}</FieldLabel>
            </Field>
          ))}
        </fieldset>
        {bots?.length ? (
          <fieldset className="space-y-1">
            <legend className="text-body text-muted-foreground">
              <Trans>Limit to these bots, or leave empty for all</Trans>
            </legend>
            {bots.map((bot) => (
              <Field key={bot.id} orientation="horizontal">
                <Checkbox
                  id={`${ids}-bot-${bot.id}`}
                  checked={botIds.includes(bot.id)}
                  onCheckedChange={(checked) =>
                    setBotIds((current) =>
                      checked === true
                        ? [...current, bot.id]
                        : current.filter((id) => id !== bot.id),
                    )
                  }
                />
                <FieldLabel htmlFor={`${ids}-bot-${bot.id}`}>{bot.name}</FieldLabel>
              </Field>
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
        {/* An empty bot list means every bot, so wait for the picker before creating. */}
        <Button type="submit" disabled={busy || !bots || !name.trim() || scopes.length === 0}>
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
      {botsFailed ? (
        <p role="alert" className="text-body text-destructive">
          <Trans>Could not load your bots</Trans>
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
              <div className="truncate text-muted-foreground">
                {expiryText(key)} · {lastUsedText(key)}
              </div>
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
