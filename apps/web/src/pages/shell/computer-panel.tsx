import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { Bot, ComputerStatus } from "@rakazo/contracts";
import { BotAvatar, Button } from "@rakazo/ui-web";
import { HardDrive, Maximize2, X } from "lucide-react";
import type { ReactNode } from "react";
import { ComputersUnavailableHint } from "../../components/ComputersUnavailableHint";
import { runsOnUserMachine } from "../../lib/computer-sandbox";
import { screenFrames, screenIframeSandbox } from "../../lib/computer-screen";
import { computerLabel, computerPlaceholder, DesktopKindEmptyState } from "./computer-view";

type ComputerPanelProps = {
  bot: Bot;
  computer: ComputerStatus | null;
  computerOpen: boolean;
  embeddedScreenUrl: string | null;
  /** Changes to load the screen again in a new frame. */
  screenFrameKey?: string;
  heldScreen?: { url: string; key: string } | null;
  screenFrameRef: (frame: HTMLIFrameElement | null) => void;
  /** True while the bot's own run holds the computer up, so watching adds no uptime. */
  livePreview: boolean;
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
          className="mt-2 flex items-center gap-2 rounded-[14px] border border-warning/40 py-1.5 ps-3 pe-1.5 text-body"
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
  heldScreen,
  screenFrameRef,
  livePreview,
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
    !runsOnUserMachine(computer) &&
    (!computer || computer.state === "stopped" || computer.state === "suspended");
  const rowClass = "flex min-h-14 items-center gap-3 rounded-xl bg-muted/50 px-4 text-body";
  // The bot's screen shows here only while its own run keeps the computer up; an idle one sleeps.
  const live =
    !computerOpen &&
    !runsOnUserMachine(computer) &&
    livePreview &&
    computer?.state === "running" &&
    Boolean(embeddedScreenUrl) &&
    !computerScreenError &&
    !showingRecoveryHint;
  const liveUrl = live ? embeddedScreenUrl : null;
  // The bot stands in for its screen whenever it is not being watched here.
  const tile = (asleep: boolean) => (
    <span aria-hidden className="relative shrink-0">
      <BotAvatar
        avatarSet={bot.avatarSet}
        color={bot.color}
        identity={bot.id}
        size={28}
        className={asleep ? "opacity-50 grayscale" : undefined}
      />
      {asleep ? (
        <span className="absolute -end-2 -top-1.5 text-caption font-medium leading-none text-muted-foreground/70">
          z<sup>z</sup>
        </span>
      ) : null}
    </span>
  );
  if (idle) {
    return (
      <div data-testid="computer-preview" data-state="idle" className={rowClass}>
        {tile(true)}
        <span className="min-w-0 flex-1 text-muted-foreground">
          <Trans>Asleep</Trans>
        </span>
        <Button variant="secondary" size="sm" data-testid="computer-preview-open" onClick={onOpen}>
          <Trans>Wake</Trans>
        </Button>
      </div>
    );
  }
  // A running computer is a row too while nothing holds it up; its screen is one click away.
  if (
    !runsOnUserMachine(computer) &&
    computer?.state === "running" &&
    !live &&
    !booting &&
    !computerBooting &&
    !computerScreenError &&
    !showingRecoveryHint
  ) {
    return (
      <div data-testid="computer-preview" data-state="running" className={rowClass}>
        {tile(false)}
        <span className="min-w-0 flex-1 text-muted-foreground">
          {computerOpen ? <Trans>Open in full window</Trans> : <Trans>Awake</Trans>}
        </span>
        {computerOpen ? null : (
          <Button
            variant="secondary"
            size="sm"
            data-testid="computer-preview-open"
            onClick={onOpen}
          >
            <Trans>Open</Trans>
          </Button>
        )}
      </div>
    );
  }
  const canOpen = !computerScreenError && !showingRecoveryHint;
  // The Open pill replaces the status text on hover; fade it so they never overlap.
  const hideOnHover = canOpen
    ? "transition-opacity group-hover:opacity-0 group-has-[:focus-visible]:opacity-0"
    : "";
  return (
    <div>
      <div
        data-testid="computer-preview"
        data-state={live ? "live" : undefined}
        className={`group relative rounded-xl ${
          live
            ? "aspect-[16/10] overflow-hidden bg-background"
            : showingRecoveryHint
              ? "bg-muted/50"
              : "overflow-hidden bg-muted/50 py-6"
        }`}
      >
        {computerOpen ? (
          <div
            className={`grid h-full place-items-center text-body text-muted-foreground/80 ${hideOnHover}`}
          >
            <Trans>Open in full window</Trans>
          </div>
        ) : runsOnUserMachine(computer) ? (
          <DesktopKindEmptyState
            className={`grid h-full place-items-center px-6 text-center text-body text-muted-foreground/80 ${hideOnHover}`}
          />
        ) : liveUrl ? (
          screenFrames(screenFrameKey, liveUrl, heldScreen).map((frame) => (
            <iframe
              key={frame.key}
              title={frame.held ? undefined : t`Bot screen`}
              aria-hidden={frame.held || undefined}
              tabIndex={frame.held ? -1 : undefined}
              ref={frame.held ? undefined : screenFrameRef}
              src={frame.url}
              sandbox={screenIframeSandbox(frame.url)}
              className={`h-full w-full border-0 bg-black${frame.held ? " absolute inset-0" : ""}`}
              allow="clipboard-read; clipboard-write"
              style={{ pointerEvents: "none" }}
            />
          ))
        ) : (
          <div
            className={`grid h-full place-items-center px-6 text-center text-body text-muted-foreground/80 ${hideOnHover}`}
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
            <span className="inline-flex items-center gap-2 rounded-full bg-background px-3.5 py-2 text-body text-foreground shadow-md">
              <Maximize2 size={15} strokeWidth={1.9} aria-hidden />
              <Trans>Open</Trans>
            </span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
