import { Trans, useLingui } from "@lingui/react/macro";
import type { CloudAgentCredentialStatus } from "@rakazo/contracts";
import { writeSaved } from "@rakazo/core/query";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Input,
} from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { SettingsGroup, SettingsRow } from "../components/SettingsRows";
import { useSpaceQueries } from "../lib/query";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";

/** Saves the signed-in user's cloud-agent key. The key is never shown again. */
export function CloudAgentSettingsPanel({ provider }: { provider: { id: string; name: string } }) {
  const { t } = useLingui();
  const name = provider.name;
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const statusOptions = queries.cloudAgentCredential.status.queryOptions();
  const statusQuery = useQuery(statusOptions);
  const status = statusQuery.data;
  const [apiKey, setApiKey] = useState("");
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shownError = error ?? (statusQuery.isError ? t`Couldn't load your key` : null);

  async function act(action: () => Promise<CloudAgentCredentialStatus>) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const next = await action();
      await writeSaved(queryClient, statusOptions.queryKey, () => next);
      setApiKey("");
    } catch (err) {
      setError(errorText(err, t`Couldn't save your key`));
    } finally {
      setPending(false);
      setConfirming(false);
    }
  }

  const connect = () => void act(() => rpc.cloudAgentCredential.connect({ apiKey }));
  const disconnect = () => void act(() => rpc.cloudAgentCredential.disconnect());

  return (
    <div data-testid="cloud-agent-settings" className="space-y-3">
      {shownError ? (
        <p role="alert" className="text-[13px] text-destructive">
          {shownError}
        </p>
      ) : null}
      {status?.status === "disconnected" ? (
        <SettingsGroup>
          <SettingsRow
            label={<p className="break-words">{name}</p>}
            control={
              <Button size="sm" disabled={pending || !apiKey.trim()} onClick={connect}>
                <Trans>Connect</Trans>
              </Button>
            }
          >
            <Input
              className="mt-2"
              type="password"
              autoComplete="off"
              aria-label={t`Key`}
              value={apiKey}
              disabled={pending}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </SettingsRow>
        </SettingsGroup>
      ) : null}
      {status?.status === "connected" ? (
        <SettingsGroup>
          <SettingsRow
            label={<p className="break-words">{name}</p>}
            control={
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                className="text-destructive hover:text-destructive"
                onClick={() => setConfirming(true)}
              >
                <Trans>Disconnect</Trans>
              </Button>
            }
          />
        </SettingsGroup>
      ) : null}
      {confirming ? (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open && !pending) setConfirming(false);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t`Disconnect ${name}?`}</AlertDialogTitle>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending}>
                <Trans>Cancel</Trans>
              </AlertDialogCancel>
              <AlertDialogAction variant="destructive" disabled={pending} onClick={disconnect}>
                <Trans>Disconnect</Trans>
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </div>
  );
}
