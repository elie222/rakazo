import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { Bot, ComputerStatus } from "@rakazo/contracts";
import { BotSleepFace, Button } from "@rakazo/ui-web";
import { HardDrive, Maximize2, X } from "lucide-react";
import type { ReactNode } from "react";
import { Shimmer } from "../../components/ai/primitives";
import { ComputersUnavailableHint } from "../../components/ComputersUnavailableHint";
import { screenIframeSandbox } from "../../lib/computer-screen";
import { computerLabel, computerPlaceholder, DesktopKindEmptyState } from "./computer-view";

type ComputerPanelProps = {
  bot: Bot;
  computer: ComputerStatus | null;
  computerOpen: boolean;
  embeddedScreenUrl: string | null;
  /** Changes to load the screen again in a new frame. */
  screenFrameKey?: string;
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
  cleaningUpDisk?: boolean;
  onCleanUpDisk?: () => void;
  onDismissDiskWarning?: () => void;
};

export function ComputerPanel({
  cleaningUpDisk,
  onCleanUpDisk,
  onDismissDiskWarning,
  ...props
}: ComputerPanelProps) {
  const percent = props.computer?.diskFullPercent;
  const warn = percent !== undefined && onCleanUpDisk && onDismissDiskWarning;
  // The preview keeps its place either way, so the warning never remounts the live screen.
  return (
    <>
      <ComputerPreview {...props} />
      {warn && (
        <div
          data-testid="computer-disk-warning"
          className="mt-2 flex items-center gap-2 rounded-xl bg-warning/15 py-1.5 ps-3 pe-1.5 text-sm"
        >
          <HardDrive aria-hidden size={15} strokeWidth={1.9} className="shrink-0 text-warning" />
          <span className="min-w-0 flex-1">
            <Trans>Computer is {percent}% full</Trans>
          </span>
          <Button variant="secondary" size="sm" disabled={cleaningUpDisk} onClick={onCleanUpDisk}>
            <Trans>Clean up</Trans>
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t`Dismiss`}
            onClick={onDismissDiskWarning}
          >
            <X size={15} aria-hidden />
          </Button>
        </div>
      )}
    </>
  );
}

function ComputerPreview({
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
}: Omit<ComputerPanelProps, "cleaningUpDisk" | "onCleanUpDisk" | "onDismissDiskWarning">) {
  // A clickable preview invites a boot that costs money, so an idle computer only wakes from its button.
  const idle =
    !computerOpen &&
    !booting &&
    !computerBooting &&
    !computerScreenError &&
    !showComputerRecoveryHint &&
    computer?.kind !== "desktop" &&
    (!computer || computer.state === "stopped" || computer.state === "suspended");
  if (idle) {
    return (
      <div
        data-testid="computer-preview"
        data-state="idle"
        className="flex aspect-[1.55] flex-col items-center justify-center gap-2 rounded-xl bg-muted px-6"
      >
        <BotSleepFace
          state="asleep"
          avatarSet={bot.avatarSet}
          color={bot.color}
          identity={bot.id}
        />
        <span className="text-sm text-foreground">
          <Trans>Asleep</Trans>
        </span>
        <Button variant="secondary" size="sm" data-testid="computer-preview-open" onClick={onOpen}>
          <Trans>Wake</Trans>
        </Button>
      </div>
    );
  }
  const canOpen = !computerScreenError && !showingRecoveryHint;
  // While the computer boots, the bot wakes up in its place: eyes open, look around, stretch.
  const waking =
    !computerOpen &&
    !computerScreenError &&
    !showComputerRecoveryHint &&
    computer?.kind !== "desktop" &&
    (booting || Boolean(computerBooting) || computer?.state === "booting");
  // The Open pill replaces the status text on hover; fade it so they never overlap.
  const hideOnHover = canOpen
    ? "transition-opacity group-hover:opacity-0 group-has-[:focus-visible]:opacity-0"
    : "";
  return (
    <div>
      <div
        data-testid="computer-preview"
        className={`group relative rounded-xl bg-muted ${
          showingRecoveryHint ? "" : "aspect-[1.55] overflow-hidden"
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
        ) : waking ? (
          <div
            data-state="waking"
            className={`flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm ${hideOnHover}`}
          >
            <BotSleepFace
              state="waking"
              avatarSet={bot.avatarSet}
              color={bot.color}
              identity={bot.id}
            />
            <Shimmer>
              {computerPlaceholder(computer?.state, true, computerLabel(computer?.mode, bot.name))}
            </Shimmer>
            <span aria-hidden className="block h-[3px] w-24 overflow-hidden rounded-full bg-accent">
              <span className="block h-full w-2/5 rounded-full bg-muted-foreground motion-safe:animate-progress-sweep" />
            </span>
          </div>
        ) : computer?.state === "running" && embeddedScreenUrl && !computerScreenError ? (
          <iframe
            key={screenFrameKey}
            title={t`Bot screen preview`}
            ref={screenFrameRef}
            src={embeddedScreenUrl}
            sandbox={screenIframeSandbox(embeddedScreenUrl)}
            className="h-full w-full border-0 bg-black motion-safe:animate-power-on"
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
