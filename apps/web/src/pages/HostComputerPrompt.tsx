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
          <DialogDescription className="leading-relaxed">
            <Trans>Docker is the default: bots use a shared Team Computer.</Trans>{" "}
            {mac ? (
              <Trans>
                macOS will not ask for extra permission if you let bots run on this Mac. They run as
                you.
              </Trans>
            ) : (
              <Trans>
                Your OS will not ask for extra permission if you let bots run on {hostLabel}. They
                run as you.
              </Trans>
            )}
          </DialogDescription>
        </DialogHeader>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <div className="flex flex-col gap-2">
          <Button size="lg" disabled={pending} onClick={() => void choose("docker")}>
            <Trans>Docker (recommended)</Trans>
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
        <p className="text-xs leading-relaxed text-muted-foreground/80">
          {mac ? (
            <Trans>
              This Mac runs shell commands with your account, including files in your home folder.
              Do not turn it on for a shared or public server.
            </Trans>
          ) : (
            <Trans>
              This computer runs shell commands with your account, including files in your home
              folder. Do not turn it on for a shared or public server.
            </Trans>
          )}
        </p>
      </DialogContent>
    </Dialog>
  );
}
