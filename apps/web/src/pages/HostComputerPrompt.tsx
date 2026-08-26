import { Trans, useLingui } from "@lingui/react/macro";
import type { Me } from "@rakazo/contracts";
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

  return (
    <div className="absolute inset-0 z-40 grid place-items-center bg-[#050506]/80 px-6">
      <div className="w-[440px] rounded-[20px] border border-[#26262A] bg-[#121214] p-6">
        <h2 className="text-[22px] font-medium text-[#F1F1F2]">
          <Trans>Where should bots run?</Trans>
        </h2>
        <p className="mt-2 text-[14px] leading-relaxed text-[#85858A]">
          <Trans>Docker is the default: bots use a shared Team Computer.</Trans>
          {mac ? (
            <Trans>
              {" "}
              macOS will not ask for extra permission if you let bots run on this Mac — they run as
              you.
            </Trans>
          ) : (
            <Trans>
              {" "}
              Your OS will not ask for extra permission if you let bots run on {hostLabel} — they
              run as you.
            </Trans>
          )}
        </p>
        {error ? <p className="mt-3 text-sm text-[#E65707]">{error}</p> : null}
        <div className="mt-5 flex flex-col gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={() => void choose("docker")}
            className="rounded-[11px] bg-[#F1F1EF] px-5 py-2.5 text-[#17171A] disabled:opacity-40"
          >
            <Trans>Docker (recommended)</Trans>
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => void choose("this-mac")}
            className="rounded-[11px] border border-[#26262A] px-5 py-2.5 text-[#ECECEE] disabled:opacity-40"
          >
            <Trans>Use {hostLabel}</Trans>
          </button>
        </div>
        <p className="mt-3 text-[12px] leading-relaxed text-[#6C6C70]">
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
      </div>
    </div>
  );
}
