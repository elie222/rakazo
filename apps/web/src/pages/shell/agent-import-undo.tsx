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
import { agentImportErrorText } from "../../lib/agent-import-errors";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";

type Names = AgentImportInfo["remove"];

const flatten = (names: Names) => [
  ...names.skills,
  ...names.spaceMemory,
  ...names.botMemory,
  ...names.mcpServers,
  ...names.routines,
  ...names.apiKeys,
];

/** Removes what the import added, keeping anything changed since. */
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
                {info.existingBot ? (
                  <Trans>What the import added will be removed. The bot stays.</Trans>
                ) : (
                  <Trans>The bot and what its import added will be removed.</Trans>
                )}
              </AlertDialogDescription>
              {info.instructions ? (
                <p
                  className="text-[13.5px] text-muted-foreground"
                  data-testid="agent-import-undo-instructions"
                >
                  {info.instructions === "restore" ? (
                    <Trans>Its instructions go back to before the import.</Trans>
                  ) : (
                    <Trans>Its instructions changed since the import, so they stay.</Trans>
                  )}
                </p>
              ) : null}
              {info.model ? (
                <p
                  className="text-[13.5px] text-muted-foreground"
                  data-testid="agent-import-undo-model"
                >
                  {info.model === "restore" ? (
                    <Trans>Its model goes back to before the import.</Trans>
                  ) : (
                    <Trans>Its model changed since the import, so it stays.</Trans>
                  )}
                </p>
              ) : null}
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
                    .importUndo({ botId, importId: info.id })
                    .then(() => onUndone())
                    .catch((err: unknown) => {
                      setError(
                        agentImportErrorText(err) ?? errorText(err, t`Could not undo the import`),
                      );
                      setBusy(false);
                      // Another tab may have undone this import meanwhile.
                      rpc.bots
                        .importInfo({ botId })
                        .then((found) => {
                          setInfo(found);
                          if (!found) setOpen(false);
                        })
                        .catch(() => undefined);
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
