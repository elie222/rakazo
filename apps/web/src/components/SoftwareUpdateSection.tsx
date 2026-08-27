import { Trans, useLingui } from "@lingui/react/macro";
import { AlertTriangle, CheckCircle2, Download, GitBranch, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";

interface UpdateState {
  available: boolean;
  currentCommit: string;
  targetCommit: string;
  isUpToDate: boolean;
  behindBy: number;
  dirty: boolean;
  changedFiles: string[];
  branch: string;
  remote: string;
  canAutoUpdate: boolean;
}

export function SoftwareUpdateSection() {
  const { t } = useLingui();
  const [allowed, setAllowed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  async function checkForUpdates() {
    setLoading(true);
    setError(null);
    setSuccessMessage(null);
    try {
      const data = await rpc.updater.check();
      setUpdateInfo(data);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t`Check failed.`;
      setError(message);
      setUpdateInfo(null);
    } finally {
      setLoading(false);
    }
  }

  async function applyUpdate() {
    if (!updateInfo?.canAutoUpdate || updating) return;
    setUpdating(true);
    setError(null);
    setSuccessMessage(null);
    try {
      const res = await rpc.updater.apply();
      if (res.success) {
        setSuccessMessage(res.message || t`Updated.`);
        await checkForUpdates();
      } else {
        setError(res.message);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t`Update failed.`;
      setError(message);
    } finally {
      setUpdating(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    void rpc
      .me()
      .then((me) => {
        if (cancelled || !me.isDeploymentOwner) return;
        setAllowed(true);
        void checkForUpdates();
      })
      .catch(() => {
        // Non-owners and failed me lookups stay hidden.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!allowed) return null;
  if (updateInfo && !updateInfo.available && !loading && !error) return null;

  const shortCurrent = updateInfo?.currentCommit.slice(0, 7) ?? "…";

  return (
    <div className="mt-5 rounded-[14px] border border-[#26262A] bg-[#101012] p-4 text-left">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#1D1D20] text-[#A8A8AD]">
            <GitBranch size={16} />
          </div>
          <div>
            <h3 className="text-[14px] font-medium text-[#ECECEE]">
              <Trans>Software Updates</Trans>
            </h3>
            <p className="text-[12px] text-[#6C6C70]">
              {updateInfo?.available ? (
                <span className="font-mono text-[#8E8E93]">{shortCurrent}</span>
              ) : (
                <Trans>Checking…</Trans>
              )}
            </p>
          </div>
        </div>

        <button
          type="button"
          disabled={loading || updating}
          onClick={() => void checkForUpdates()}
          className="flex items-center gap-1.5 rounded-lg border border-[#2B2B30] bg-[#1A1A1D] px-2.5 py-1 text-[12px] font-medium text-[#C9C9CE] transition hover:bg-[#26262B] disabled:opacity-40"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          <span>{loading ? t`Checking…` : t`Check`}</span>
        </button>
      </div>

      {updateInfo?.available ? (
        <div className="mt-3.5 border-t border-[#1C1C20] pt-3">
          {updateInfo.isUpToDate ? (
            <div className="flex items-center gap-2 text-[13px] text-[#4EBA6F]">
              <CheckCircle2 size={15} />
              <span>
                <Trans>Up to date</Trans>
              </span>
            </div>
          ) : updateInfo.dirty ? (
            <div className="flex items-start gap-2 text-[12.5px] text-[#E5A83B]">
              <AlertTriangle size={15} className="mt-0.5 shrink-0" />
              <p className="font-medium">
                <Trans>Local changes. Stash or commit first.</Trans>
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-[13px] font-medium text-[#E5A83B]">
                <Trans>
                  {updateInfo.behindBy} update{updateInfo.behindBy === 1 ? "" : "s"} available
                </Trans>
              </p>
              <button
                type="button"
                disabled={updating}
                onClick={() => void applyUpdate()}
                className="flex items-center justify-center gap-1.5 rounded-lg bg-[#3273DC] px-3 py-1.5 text-[12.5px] font-medium text-white shadow transition hover:bg-[#2764C4] disabled:opacity-50"
              >
                <Download size={13} className={updating ? "animate-bounce" : ""} />
                <span>{updating ? t`Updating…` : t`Update`}</span>
              </button>
            </div>
          )}
        </div>
      ) : null}

      {error ? (
        <div className="mt-3 rounded-lg border border-[#4A2020] bg-[#221212] px-3 py-2 text-[12px] text-[#F07178]">
          {error}
        </div>
      ) : null}

      {successMessage ? (
        <div className="mt-3 rounded-lg border border-[#1E3B27] bg-[#0F2015] px-3 py-2 text-[12px] text-[#4EBA6F]">
          {successMessage}
        </div>
      ) : null}
    </div>
  );
}
