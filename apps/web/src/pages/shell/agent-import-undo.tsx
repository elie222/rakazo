import { Trans, useLingui } from "@lingui/react/macro";
import type { AgentImportInfo } from "@rakazo/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";

type Names = AgentImportInfo["remove"];

const flatten = (names: Names) => [
  ...names.skills,
  ...names.spaceMemory,
  ...names.mcpServers,
  ...names.apiKeys,
];

/**
 * "Undo import" for a bot that came from an agent import: removes the bot and what the
 * import added, keeping anything changed since. Renders nothing for other bots.
 */
export function AgentImportUndo({ botId, onUndone }: { botId: string; onUndone: () => void }) {
  const { t } = useLingui();
  const [info, setInfo] = useState<AgentImportInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    rpc.bots
      .importInfo({ botId })
      .then((found) => {
        if (current) setInfo(found);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [botId]);

  if (!info) return null;
  const removed = flatten(info.remove);
  const kept = flatten(info.keep);

  return (
    <>
      <button
        type="button"
        data-testid="agent-import-undo"
        className="min-h-12 w-full border-t border-border text-start text-sm text-destructive"
        onClick={() => setOpen(true)}
      >
        <Trans>Undo import</Trans>
      </button>
      {open ? (
        <AlertDialog
          open
          onOpenChange={(next) => {
            if (!next && !busy) setOpen(false);
          }}
        >
          <AlertDialogContent data-testid="agent-import-undo-dialog">
            <AlertDialogHeader>
              <AlertDialogTitle>
                <Trans>Undo import?</Trans>
              </AlertDialogTitle>
              <AlertDialogDescription>
                <Trans>The bot and what its import added will be removed.</Trans>
              </AlertDialogDescription>
            </AlertDialogHeader>
            {removed.length ? (
              <section aria-label={t`Removed`}>
                <p className="text-[13.5px] text-foreground/75">
                  <Trans>Removed</Trans>
                </p>
                <ul className="mt-1 text-[13px] text-muted-foreground">
                  {removed.map((name, index) => (
                    <li key={`${index}:${name}`} dir="auto">
                      {name}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {kept.length ? (
              <section aria-label={t`Kept`}>
                <p className="text-[13.5px] text-foreground/75">
                  <Trans>Kept</Trans>
                </p>
                <ul className="mt-1 text-[13px] text-muted-foreground">
                  {kept.map((name, index) => (
                    <li key={`${index}:${name}`} dir="auto">
                      {name}
                    </li>
                  ))}
                </ul>
                {info.keep.apiKeys.length ? (
                  <p className="mt-1 text-[13px] text-muted-foreground">
                    <Trans>API keys stay connected.</Trans>
                  </p>
                ) : null}
              </section>
            ) : null}
            {error ? (
              <p role="alert" className="text-[13.5px] text-destructive">
                {error}
              </p>
            ) : null}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>
                <Trans>Cancel</Trans>
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setError(null);
                  rpc.bots
                    .importUndo({ botId })
                    .then(() => onUndone())
                    .catch((err: unknown) => {
                      setError(errorText(err, t`Could not undo the import`));
                      setBusy(false);
                    });
                }}
              >
                <Trans>Undo import</Trans>
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </>
  );
}
