import type { DesktopUpdateState } from "@rakazo/contracts";
import { X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { buildIdentity, clientKind } from "../lib/build-info";
import { desktopBridge } from "../lib/desktop";
import { rpc } from "../lib/rpc";
import { type VersionNotice as Notice, resolveVersionNotice } from "../lib/version-notice";

const POLL_MS = 5 * 60 * 1000;

/**
 * Advisory only. A version difference never stops the app from working, so this is a banner the
 * user can dismiss, not a gate. It re-appears if the situation changes to something new.
 */
export function VersionNotice() {
  const desktop = desktopBridge();
  const [server, setServer] = useState<{ version: string; revision: string | null } | null>(null);
  const [desktopUpdate, setDesktopUpdate] = useState<DesktopUpdateState | null>(null);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const refresh = useCallback(async () => {
    const [health, update] = await Promise.all([
      rpc.health().catch(() => null),
      desktop ? desktop.update.state().catch(() => null) : Promise.resolve(null),
    ]);
    if (health) setServer({ version: health.version, revision: health.revision });
    if (update) setDesktopUpdate(update);
  }, [desktop]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  const notice = resolveVersionNotice({
    client: buildIdentity,
    clientKind: clientKind(Boolean(desktop)),
    server,
    desktop: desktopUpdate,
  });
  if (notice === null || notice.key === dismissedKey) return null;

  async function act(current: Notice) {
    if (current.action === "reload") {
      window.location.reload();
      return;
    }
    if (!desktop) return;
    setPending(true);
    try {
      const next =
        current.action === "download-desktop"
          ? await desktop.update.download()
          : await desktop.update.install();
      setDesktopUpdate(next);
    } catch {
      setDismissedKey(current.key);
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      role="status"
      className="fixed left-1/2 top-4 z-50 w-[min(520px,calc(100vw-2rem))] -translate-x-1/2 rounded-[16px] border border-[#343438] bg-[#1A1A1D] px-4 py-3.5 shadow-[0_18px_40px_rgba(0,0,0,.5)]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[14.5px] font-medium text-[#F1F1F2]">{notice.title}</p>
          <p className="mt-1 text-[13px] leading-[1.5] text-[#8E8EA0]">{notice.detail}</p>
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => setDismissedKey(notice.key)}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-[8px] text-[#6C6C70] hover:bg-[#222226] hover:text-[#C9C9CE]"
        >
          <X size={14} />
        </button>
      </div>
      {notice.action && notice.actionLabel ? (
        <button
          type="button"
          disabled={pending || notice.busy}
          onClick={() => void act(notice)}
          className="mt-3 rounded-full border border-[#343438] px-3.5 py-1.5 text-[13px] text-[#ECECEE] hover:bg-[#222226] disabled:opacity-50"
        >
          {pending ? "Working…" : notice.actionLabel}
        </button>
      ) : null}
    </div>
  );
}
