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
import { useSpaceQueries } from "../../lib/query";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";
import { BotPanelGroup } from "./bot-settings-sections";

/**
 * Lets this bot reach the signed-in member's tailnet. The connection is the member's own in this
 * Space; nothing shows on a server that can't put bots on a tailnet.
 */
export function TailnetGroup({ botId }: { botId: string }) {
  const { t } = useLingui();
  const ids = useId();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const statusOptions = queries.tailnet.status.queryOptions();
  const status = useQuery(statusOptions).data;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  if (!status || status.unavailable) return null;
  const connection = status.connection;

  async function act(action: () => Promise<TailnetStatus>) {
    setPending(true);
    setError(null);
    try {
      const next = await action();
      await writeSaved(queryClient, statusOptions.queryKey, () => next);
    } catch (reason) {
      setError(errorText(reason, t`Couldn't update tailnet access`));
    } finally {
      setPending(false);
    }
  }

  return (
    <BotPanelGroup label={t`Tailnet`}>
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
              onCheckedChange={(enabled) =>
                void act(() => rpc.tailnet.setBotAccess({ botId, enabled }))
              }
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
          await writeSaved(queryClient, statusOptions.queryKey, () => next);
          setConnecting(false);
        }}
      />
      {confirmingDisconnect ? (
        <ConfirmDialog
          onCancel={() => setConfirmingDisconnect(false)}
          title={t`Disconnect tailnet?`}
          busy={pending}
          onConfirm={() =>
            void act(() => rpc.tailnet.disconnect()).finally(() => setConfirmingDisconnect(false))
          }
          confirmLabel={<Trans>Disconnect</Trans>}
        />
      ) : null}
    </BotPanelGroup>
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setClientId("");
    setClientSecret("");
    setTag("");
    setError(null);
  }

  async function connect() {
    if (saving || !clientId.trim() || !clientSecret.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const next = await rpc.tailnet.connect({
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        ...(tag.trim() ? { tag: tag.trim() } : {}),
      });
      reset();
      await onConnected(next);
    } catch (reason) {
      setError(errorText(reason, t`Couldn't connect tailnet`));
    } finally {
      setSaving(false);
    }
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
            void connect();
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
