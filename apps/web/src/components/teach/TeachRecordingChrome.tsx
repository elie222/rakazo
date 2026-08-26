import { Trans } from "@lingui/react/macro";
import type { TaughtSkill } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useEffect, useState } from "react";

export function formatRemaining(expiresAt: string | null): string {
  if (!expiresAt) return "10:00";
  const ms = Math.max(0, new Date(expiresAt).getTime() - Date.now());
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function TeachRecordingChrome({
  recording,
  busy,
  onStop,
  variant = "panel",
}: {
  recording: TaughtSkill;
  busy?: boolean;
  onStop: () => void | Promise<void>;
  variant?: "panel" | "overlay";
}) {
  const [remaining, setRemaining] = useState(() => formatRemaining(recording.expiresAt));

  useEffect(() => {
    setRemaining(formatRemaining(recording.expiresAt));
    const timer = window.setInterval(() => {
      setRemaining(formatRemaining(recording.expiresAt));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [recording.expiresAt]);

  if (variant === "overlay") {
    return (
      <div
        data-testid="teach-recording-overlay"
        className="flex min-w-0 flex-1 flex-col gap-1 px-3"
      >
        <div className="truncate text-[13px] text-[#ECECEE]">
          <Trans>Recording: {recording.goal}</Trans>
        </div>
        <div className="text-[12px] text-[#85858A]">
          <Trans>{remaining} left · bot is watching, not acting</Trans>
        </div>
        <div className="text-[12px] text-[#E65707]">
          <Trans>Do not type passwords into the demo. Use Take control for credentials.</Trans>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="teach-recording"
      className="rounded-[11px] border border-[#232326] bg-[#121214] px-3 py-3"
    >
      <div className="text-[14px] text-[#ECECEE]">
        <Trans>Recording: {recording.goal}</Trans>
      </div>
      <div className="mt-1 text-[13px] text-[#85858A]">
        <Trans>{remaining} left · bot is watching, not acting</Trans>
      </div>
      <div className="mt-2 text-[13px] text-[#E65707]">
        <Trans>Do not type passwords into the demo. Use Take control for credentials.</Trans>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-3"
        disabled={busy}
        data-testid="teach-stop-button"
        onClick={() => void onStop()}
      >
        <Trans>Stop teaching</Trans>
      </Button>
    </div>
  );
}

export function TeachStopButton({
  busy,
  onStop,
}: {
  busy?: boolean;
  onStop: () => void | Promise<void>;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={busy}
      data-testid="teach-stop-overlay"
      onClick={() => void onStop()}
    >
      <Trans>Stop teaching</Trans>
    </Button>
  );
}
