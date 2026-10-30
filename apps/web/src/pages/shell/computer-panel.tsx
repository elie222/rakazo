import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { Bot, ComputerStatus } from "@rakazo/contracts";
import { Maximize2 } from "lucide-react";
import type { ReactNode } from "react";
import { ComputersUnavailableHint } from "../../components/ComputersUnavailableHint";
import { screenIframeSandbox } from "../../lib/computer-screen";
import { computerLabel, computerPlaceholder, DesktopKindEmptyState } from "./computer-view";

type ComputerPanelProps = {
  bot: Bot;
  computer: ComputerStatus | null;
  computerOpen: boolean;
  embeddedScreenUrl: string | null;
  /** Changes to load the screen again in a new frame. */
  screenFrameKey?: number;
  screenFrameRef: (frame: HTMLIFrameElement | null) => void;
  computerScreenError: ReactNode;
  computerBooting: ReactNode;
  booting: boolean;
  showingRecoveryHint: boolean;
  showComputerRecoveryHint: boolean;
  sandboxProvider?: string | null;
  onRecovered: (sandboxProvider: string) => void;
  onRecoveryDismissed: () => void;
  onOpenComputerSettings?: () => void;
  onOpen: () => void;
};

export function ComputerPanel({
  bot,
  computer,
  computerOpen,
  embeddedScreenUrl,
  screenFrameKey,
  screenFrameRef,
  computerScreenError,
  computerBooting,
  booting,
  showingRecoveryHint,
  showComputerRecoveryHint,
  sandboxProvider,
  onRecovered,
  onRecoveryDismissed,
  onOpenComputerSettings,
  onOpen,
}: ComputerPanelProps) {
  const canOpen = !computerScreenError && !showingRecoveryHint;
  // The Open pill replaces the status text on hover; fade it so they never overlap.
  const hideOnHover = canOpen
    ? "transition-opacity group-hover:opacity-0 group-has-[:focus-visible]:opacity-0"
    : "";
  return (
    <div>
      <div
        data-testid="computer-preview"
        className={`group relative rounded-[14px] bg-background ${
          showingRecoveryHint ? "" : "aspect-[16/10] overflow-hidden"
        }`}
      >
        {computerOpen ? (
          <div
            className={`grid h-full place-items-center text-sm text-muted-foreground/80 ${hideOnHover}`}
          >
            <Trans>Open in full window</Trans>
          </div>
        ) : computer?.kind === "desktop" ? (
          <DesktopKindEmptyState
            className={`grid h-full place-items-center px-6 text-center text-sm text-muted-foreground/80 ${hideOnHover}`}
          />
        ) : computer?.state === "running" && embeddedScreenUrl && !computerScreenError ? (
          <iframe
            key={screenFrameKey}
            title={t`Bot screen preview`}
            ref={screenFrameRef}
            src={embeddedScreenUrl}
            sandbox={screenIframeSandbox(embeddedScreenUrl)}
            className="h-full w-full border-0 bg-black"
            allow="clipboard-read; clipboard-write"
            style={{ pointerEvents: "none" }}
          />
        ) : (
          <div
            className={`grid h-full place-items-center px-6 text-center text-sm text-muted-foreground/80 ${hideOnHover}`}
          >
            {computerScreenError ??
              (showComputerRecoveryHint ? (
                <ComputersUnavailableHint
                  sandboxProvider={sandboxProvider}
                  onRecovered={onRecovered}
                  onRecoveryDismissed={onRecoveryDismissed}
                  onOpenComputerSettings={onOpenComputerSettings}
                />
              ) : (
                (computerBooting ??
                computerPlaceholder(
                  computer?.state,
                  booting,
                  computerLabel(computer?.mode, bot.name),
                ))
              ))}
          </div>
        )}
        {canOpen ? (
          <button
            type="button"
            data-testid="computer-preview-open"
            className="absolute inset-0 flex cursor-pointer items-center justify-center bg-overlay/40 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            aria-label={t`Open`}
            onClick={onOpen}
          >
            <span className="inline-flex items-center gap-2 rounded-full bg-background px-3.5 py-2 text-[14px] text-foreground shadow-md">
              <Maximize2 size={15} strokeWidth={1.9} aria-hidden />
              <Trans>Open</Trans>
            </span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
