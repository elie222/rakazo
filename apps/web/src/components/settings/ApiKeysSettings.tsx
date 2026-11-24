import { Trans, useLingui } from "@lingui/react/macro";
import type { ApiKey, CreatedApiKey } from "@rakazo/contracts";
import { API_KEY_NAME_LIMIT, isIdentityConfirmationRequired } from "@rakazo/contracts";
import { Button, Input } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, Trash2 } from "lucide-react";
import { useState } from "react";
import { useCopyText } from "../../lib/copy-text";
import { formatRelativeTime } from "../../lib/locale/relative-time";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { SpaceRpcProvider } from "../../lib/query/space-rpc";
import { errorText } from "../../lib/query/user-error";
import { useIdentityConfirmation } from "../account/ConfirmIdentityDialog";
import { ConfirmDialog } from "../ConfirmDialog";
import { SettingsGroup, SettingsRow } from "./SettingsRows";

/** Keys that let scripts and other agents use this account's bots. They belong to the person. */
export function ApiKeysSettings() {
  return (
    <SpaceRpcProvider spaceId={null}>
      <ApiKeysList />
    </SpaceRpcProvider>
  );
}

function ApiKeysList() {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const keys = useQuery(queries.apiKeys.list.queryOptions());
  const { withIdentityConfirmation, identityDialog } = useIdentityConfirmation();
  const [naming, setNaming] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [deleting, setDeleting] = useState<ApiKey | null>(null);
  const stale = [queries.apiKeys.list.queryKey()];
  const create = useSave({
    save: (name: string, rpc) => withIdentityConfirmation(() => rpc.apiKeys.create({ name })),
    stale,
    onSaved: (key) => {
      setNaming(null);
      setCreated(key);
    },
  });
  const revoke = useSave({
    save: (id: string, rpc) => rpc.apiKeys.revoke({ id }),
    stale,
    onSaved: () => setDeleting(null),
  });
  const createError =
    create.error && !isIdentityConfirmationRequired(create.error)
      ? errorText(create.error, t`Could not continue`)
      : null;
  const revokeError = revoke.error ? errorText(revoke.error, t`Could not continue`) : null;

  return (
    <SettingsGroup title={<Trans>API keys</Trans>} data-testid="api-keys">
      <SettingsRow
        label={<Trans>Use your bots from scripts and other agents</Trans>}
        control={
          naming === null ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setCreated(null);
                setNaming("");
              }}
            >
              <Trans>Create key</Trans>
            </Button>
          ) : null
        }
      >
        {naming !== null ? (
          <form
            className="mt-2 flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (naming.trim()) create.run(naming.trim());
            }}
          >
            <Input
              aria-label={t`Key name`}
              placeholder={t`Name`}
              value={naming}
              maxLength={API_KEY_NAME_LIMIT}
              autoFocus
              onChange={(event) => setNaming(event.target.value)}
              className="flex-1"
            />
            <Button type="submit" size="sm" disabled={create.pending || !naming.trim()}>
              <Trans>Create</Trans>
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setNaming(null)}>
              <Trans>Cancel</Trans>
            </Button>
          </form>
        ) : null}
        {created ? <NewKey created={created} /> : null}
        {createError ? (
          <p role="alert" className="mt-2 text-body-sm text-destructive">
            {createError}
          </p>
        ) : null}
      </SettingsRow>
      {(keys.data ?? []).map((key) => (
        <SettingsRow
          key={key.id}
          label={
            <p className="flex min-w-0 items-baseline gap-2">
              <span className="truncate">{key.name}</span>
              <span className="shrink-0 font-mono text-body-sm text-muted-foreground">
                {key.start}…
              </span>
              <span className="shrink-0 text-body-sm text-muted-foreground">
                {key.lastUsedAt ? (
                  <Trans>Used {formatRelativeTime(key.lastUsedAt)}</Trans>
                ) : (
                  <Trans>Never used</Trans>
                )}
              </span>
            </p>
          }
          control={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t`Delete ${key.name}`}
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(key)}
            >
              <Trash2 />
            </Button>
          }
        />
      ))}
      {deleting ? (
        <ConfirmDialog
          onCancel={() => {
            setDeleting(null);
            revoke.reset();
          }}
          title={t`Delete "${deleting.name}"?`}
          description={<Trans>Anything using this key stops working.</Trans>}
          error={revokeError}
          busy={revoke.pending}
          onConfirm={() => revoke.run(deleting.id)}
          confirmLabel={revoke.pending ? <Trans>Deleting…</Trans> : <Trans>Delete</Trans>}
        />
      ) : null}
      {identityDialog}
    </SettingsGroup>
  );
}

/** The new key, shown only now: the server keeps a hash. */
function NewKey({ created }: { created: CreatedApiKey }) {
  const { t } = useLingui();
  const [copied, copy] = useCopyText();
  return (
    <div className="mt-2 space-y-1" data-testid="api-key-created">
      <div className="flex items-center gap-1 rounded-lg bg-muted py-0.5 pr-0.5 pl-2.5">
        <span className="min-w-0 flex-1 break-all font-mono text-label text-foreground/75">
          {created.key}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={copied ? t`Copied` : t`Copy key`}
          onClick={() => copy(created.key)}
          className="text-muted-foreground"
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      </div>
      <p className="text-body-sm text-muted-foreground">
        <Trans>Copy it now. It won't be shown again.</Trans>
      </p>
    </div>
  );
}
