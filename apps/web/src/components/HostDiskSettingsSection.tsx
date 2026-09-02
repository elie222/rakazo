import { Trans, useLingui } from "@lingui/react/macro";
import type { HostDiskSettings } from "@rakazo/contracts";
import { useEffect, useState } from "react";
import { desktopBridge } from "../lib/desktop";
import { rpc } from "../lib/rpc";

/**
 * Opt-in host-disk access for the Mac/desktop client. Hidden in plain browsers.
 * Never invents Documents/Desktop roots; the user must grant folders.
 */
export function HostDiskSettingsSection() {
  const { t } = useLingui();
  const desktop = desktopBridge();
  const [settings, setSettings] = useState<HostDiskSettings | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!desktop?.hostDisk) return;
    let cancelled = false;
    void rpc.hostDisk
      .get()
      .then((next) => {
        if (!cancelled) setSettings(next);
      })
      .catch(() => {
        if (!cancelled) setSettings(null);
      });
    return () => {
      cancelled = true;
    };
  }, [desktop]);

  if (!desktop?.hostDisk) return null;

  async function setEnabled(enabled: boolean) {
    setPending(true);
    setError(null);
    try {
      const next = await rpc.hostDisk.setEnabled({ enabled });
      setSettings(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Couldn't update host disk access`);
    } finally {
      setPending(false);
    }
  }

  async function grantFolder() {
    setPending(true);
    setError(null);
    try {
      const folder = await desktop!.hostDisk.pickFolder();
      if (!folder) return;
      const roots = [...new Set([...(settings?.roots ?? []), folder])];
      const next = await rpc.hostDisk.setRoots({ roots });
      setSettings(next);
      await rpc.hostDisk.heartbeat();
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Couldn't grant that folder`);
    } finally {
      setPending(false);
    }
  }

  async function removeRoot(root: string) {
    setPending(true);
    setError(null);
    try {
      await desktop!.hostDisk.revokeRoot(root);
      const roots = (settings?.roots ?? []).filter((item) => item !== root);
      const next = await rpc.hostDisk.setRoots({ roots });
      setSettings(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Couldn't update folders`);
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      className="mt-5 rounded-[14px] border border-[#26262A] bg-[#101012] px-4 py-4"
      data-testid="host-disk-settings"
    >
      <h3 className="text-[15px] font-medium text-[#ECECEE]">
        <Trans>This computer</Trans>
      </h3>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={pending}
          data-testid="host-disk-toggle"
          onClick={() => void setEnabled(!(settings?.enabled ?? false))}
          className="rounded-full bg-[#26262A] px-4 py-2 text-[13.5px] font-medium text-[#ECECEE] disabled:opacity-50"
        >
          {settings?.enabled ? <Trans>Turn off</Trans> : <Trans>Turn on</Trans>}
        </button>
        {settings?.enabled ? (
          <button
            type="button"
            disabled={pending}
            data-testid="host-disk-grant"
            onClick={() => void grantFolder()}
            className="rounded-full border border-[#26262A] px-4 py-2 text-[13.5px] font-medium text-[#ECECEE] disabled:opacity-50"
          >
            <Trans>Grant folder</Trans>
          </button>
        ) : null}
      </div>
      {settings?.enabled && (settings.roots.length ?? 0) > 0 ? (
        <ul className="mt-3 space-y-2">
          {settings.roots.map((root) => (
            <li
              key={root}
              className="flex items-center justify-between gap-3 rounded-[10px] border border-[#1E1E22] px-3 py-2 text-[12.5px] text-[#C9C9CE]"
            >
              <span className="min-w-0 truncate" title={root}>
                {root}
              </span>
              <button
                type="button"
                disabled={pending}
                onClick={() => void removeRoot(root)}
                className="shrink-0 text-[#9A9AA0] hover:text-[#ECECEE] disabled:opacity-50"
              >
                <Trans>Remove</Trans>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-[12.5px] text-[#F1A8A8]">
          {error}
        </p>
      ) : null}
    </section>
  );
}
