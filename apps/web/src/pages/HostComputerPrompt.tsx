import { Trans, useLingui } from "@lingui/react/macro";
import type { Me } from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { desktopBridge } from "../lib/desktop";
import { rpc } from "../lib/rpc";

export function HostComputerPrompt({ initialMe }: { initialMe?: Me }) {
  const { t } = useLingui();
  const desktop = desktopBridge();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mac = desktop?.platform === "darwin";
  const hostLabel = mac ? t`this Mac` : t`this computer`;

  useEffect(() => {
    if (!desktop) return;
    if (initialMe) {
      if (initialMe.canChooseHostComputer && initialMe.computerHost == null) setOpen(true);
      return;
    }
    void rpc
      .me()
      .then((me) => {
        if (me.canChooseHostComputer && me.computerHost == null) setOpen(true);
      })
      .catch(() => undefined);
  }, [desktop, initialMe]);

  if (!open) return null;

  async function choose(computerHost: "docker" | "this-mac") {
    setPending(true);
    setError(null);
    try {
      await rpc.deployment.update({ computerHost });
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not save that choice`);
    } finally {
      setPending(false);
    }
  }

  // The choice is required, so the dialog stays open until one is saved.
  return (
    <Dialog open>
      <DialogContent showCloseButton={false} className="rounded-2xl p-6 sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="text-[22px]">
            <Trans>Where should bots run?</Trans>
          </DialogTitle>
          <DialogDescription className="space-y-2 leading-relaxed">
            <span className="block">
              <Trans>
                Docker limits access to your computer for added security. Using {hostLabel} lets
                bots work with your local files and tools.
              </Trans>
            </span>
            <span className="block text-xs text-muted-foreground/80">
              <Trans>
                Local access lets bots run commands without asking. Avoid it on shared or public
                servers.
              </Trans>
            </span>
          </DialogDescription>
        </DialogHeader>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <div className="flex flex-col gap-2">
          <Button
            variant="outline"
            size="lg"
            disabled={pending}
            onClick={() => void choose("docker")}
          >
            <Trans>Docker</Trans>
          </Button>
          <Button
            variant="outline"
            size="lg"
            disabled={pending}
            onClick={() => void choose("this-mac")}
          >
            <Trans>Use {hostLabel}</Trans>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
