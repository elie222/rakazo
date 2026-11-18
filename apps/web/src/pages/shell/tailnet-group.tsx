import { Trans, useLingui } from "@lingui/react/macro";
import type { TailnetStatus } from "@rakazo/contracts";
import { TAILNET_DEFAULT_TAG } from "@rakazo/contracts";
import { writeSaved } from "@rakazo/core/query";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldError,
  FieldLabel,
  Input,
  Switch,
} from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { errorText } from "../../lib/query/user-error";
import { PanelSection } from "./bots/bot-settings-sections";

/**
 * Lets this bot reach the signed-in member's tailnet. The connection is the member's own in this
 * Space; nothing shows on a server that can't put bots on a tailnet.
 */
export function TailnetGroup({ botId }: { botId: string }) {
  const { t } = useLingui();
  const ids = useId();
  const queries = useSpaceQueries();
  const statusOptions = queries.tailnet.status.queryOptions();
  const status = useQuery(statusOptions).data;
  const queryClient = useQueryClient();
  // Each save answers with the status after it, which shows at once.
  const saved = (next: TailnetStatus) =>
    writeSaved(queryClient, statusOptions.queryKey, () => next);
  const [connecting, setConnecting] = useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const access = useSave({
    save: (enabled: boolean, client) => client.tailnet.setBotAccess({ botId, enabled }),
    onSaved: saved,
  });
  const disconnect = useSave<void, TailnetStatus>({
    save: (_input, client) => client.tailnet.disconnect(),
    onSaved: async (next) => {
      await saved(next);
      setConfirmingDisconnect(false);
    },
    onFailed: () => setConfirmingDisconnect(false),
  });

  if (!status || status.unavailable) return null;
  const connection = status.connection;
  const pending = access.pending || disconnect.pending;
  const failed = access.error ?? disconnect.error;
  const error = failed ? errorText(failed, t`Couldn't update tailnet access`) : null;

  return (
    <PanelSection label={t`Tailnet`}>
      {connection ? (
        <>
          <div className="flex min-h-11 items-center justify-between gap-3 text-body">
            <label htmlFor={`${ids}-tailnet`} className="text-body text-foreground">
              <Trans>Reach machines on your tailnet</Trans>
            </label>
            <Switch
              id={`${ids}-tailnet`}
              checked={connection.botIds.includes(botId)}
              disabled={pending}
              onCheckedChange={(enabled) => access.run(enabled)}
            />
          </div>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            className="text-destructive hover:text-destructive"
            onClick={() => setConfirmingDisconnect(true)}
          >
            <Trans>Disconnect tailnet</Trans>
          </Button>
        </>
      ) : (
        <Button size="sm" variant="outline" disabled={pending} onClick={() => setConnecting(true)}>
          <Trans>Connect tailnet</Trans>
        </Button>
      )}
      {error ? (
        <p role="alert" className="text-body-sm text-destructive">
          {error}
        </p>
      ) : null}
      <ConnectTailnetDialog
        open={connecting}
        onOpenChange={setConnecting}
        onConnected={async (next) => {
          await saved(next);
          setConnecting(false);
        }}
      />
      {confirmingDisconnect ? (
        <ConfirmDialog
          onCancel={() => setConfirmingDisconnect(false)}
          title={t`Disconnect tailnet?`}
          busy={disconnect.pending}
          onConfirm={() => disconnect.run()}
          confirmLabel={<Trans>Disconnect</Trans>}
        />
      ) : null}
    </PanelSection>
  );
}

/** A tailnet admin's OAuth client, checked with the tailnet before it is saved. */
function ConnectTailnetDialog({
  open,
  onOpenChange,
  onConnected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: (status: TailnetStatus) => Promise<void>;
}) {
  const { t } = useLingui();
  const ids = useId();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [tag, setTag] = useState("");
  const save = useSave({
    save: (input: { clientId: string; clientSecret: string; tag?: string }, client) =>
      client.tailnet.connect(input),
    onSaved: async (next) => {
      reset();
      await onConnected(next);
    },
  });
  const saving = save.pending;
  const error = save.error ? errorText(save.error, t`Couldn't connect tailnet`) : null;

  function reset() {
    setClientId("");
    setClientSecret("");
    setTag("");
    save.reset();
  }

  function connect() {
    if (!clientId.trim() || !clientSecret.trim()) return;
    save.run({
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
      ...(tag.trim() ? { tag: tag.trim() } : {}),
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (saving) return;
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <Trans>Connect tailnet</Trans>
          </DialogTitle>
        </DialogHeader>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            connect();
          }}
        >
          <Field>
            <FieldLabel htmlFor={`${ids}-client-id`}>
              <Trans>OAuth client ID</Trans>
            </FieldLabel>
            <Input
              id={`${ids}-client-id`}
              autoComplete="off"
              value={clientId}
              disabled={saving}
              onChange={(event) => setClientId(event.target.value)}
              autoFocus
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${ids}-client-secret`}>
              <Trans>OAuth client secret</Trans>
            </FieldLabel>
            <Input
              id={`${ids}-client-secret`}
              type="password"
              autoComplete="off"
              value={clientSecret}
              disabled={saving}
              onChange={(event) => setClientSecret(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${ids}-tag`}>
              <Trans>Tag</Trans>
            </FieldLabel>
            <Input
              id={`${ids}-tag`}
              autoComplete="off"
              placeholder={TAILNET_DEFAULT_TAG}
              value={tag}
              disabled={saving}
              onChange={(event) => setTag(event.target.value)}
            />
            <FieldError>{error}</FieldError>
          </Field>
          <DialogFooter>
            <Button type="submit" disabled={saving || !clientId.trim() || !clientSecret.trim()}>
              <Trans>Connect</Trans>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
