import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type {
  Bot,
  ComputerReleaseReason,
  ComputerStatus,
  Run,
  TaughtSkill,
} from "@rakazo/contracts";
import { BotAvatar, Button } from "@rakazo/ui-web";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { ComputerMaintenanceActions } from "../../components/ComputerMaintenanceActions";
import { TeachCaptureOverlay } from "../../components/teach/TeachCaptureOverlay";
import { TeachComputerOverlayControl } from "../../components/teach/TeachComputerOverlay";
import { TeachRecordingChrome, TeachStopButton } from "../../components/teach/TeachRecordingChrome";
import { screenIframeSandbox } from "../../lib/computer-screen";
import { computerTakeoverBlocked } from "../../lib/thread-events";
import { ComputerReleaseActions } from "./computer-release-actions";
import { computerLabel, DesktopKindEmptyState } from "./computer-view";

type ComputerOverlayProps = {
  bot: Bot;
  computer: ComputerStatus | null;
  computerViewport: { height: number; offsetTop: number } | null;
  recordingSkill: TaughtSkill | null;
  teachBusy: boolean;
  hasControl: boolean;
  composerRunning: boolean;
  sending: boolean;
  booting: boolean;
  runStatus?: Run["status"];
  sendError: string | null;
  embeddedScreenUrl: string | null;
  /** Changes to load the screen again in a new frame. */
  screenFrameKey?: number;
  screenFrameRef: (frame: HTMLIFrameElement | null) => void;
  computerScreenError: ReactNode;
  computerBooting: ReactNode;
  onStopTeaching: () => void | Promise<void>;
  onStopRun: () => void;
  onRelease: (reason?: ComputerReleaseReason) => Promise<void>;
  onTakeControl: () => void;
  onStart: () => void;
  onRefreshTeaching: () => Promise<void>;
  onRefreshComputer: () => Promise<void>;
  onClose: () => void;
};

export function ComputerOverlay({
  bot,
  computer,
  computerViewport,
  recordingSkill,
  teachBusy,
  hasControl,
  composerRunning,
  sending,
  booting,
  runStatus,
  sendError,
  embeddedScreenUrl,
  screenFrameKey,
  screenFrameRef,
  computerScreenError,
  computerBooting,
  onStopTeaching,
  onStopRun,
  onRelease,
  onTakeControl,
  onStart,
  onRefreshTeaching,
  onRefreshComputer,
  onClose,
}: ComputerOverlayProps) {
  return (
    <div className="fixed inset-0 z-30 bg-background">
      <div
        data-testid="computer-viewport"
        className="fixed inset-x-0 top-0 flex flex-col bg-background pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]"
        style={{
          height: computerViewport ? `${computerViewport.height}px` : "100dvh",
          top: computerViewport ? `${computerViewport.offsetTop}px` : undefined,
        }}
      >
        <div
          data-testid="computer-chrome"
          className="app-no-drag flex items-center justify-between gap-4 border-b border-sidebar-border px-[18px] py-3.5"
        >
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <BotAvatar
              avatarSet={bot.avatarSet}
              color={bot.color}
              identity={bot.id}
              size={28}
              status={bot.status}
            />
            {recordingSkill ? (
              <TeachRecordingChrome
                recording={recordingSkill}
                botId={bot.id}
                busy={teachBusy}
                onStop={onStopTeaching}
                variant="overlay"
              />
            ) : (
              <span className="truncate text-[15.5px] font-medium text-foreground" dir="auto">
                {computerLabel(computer?.mode, bot.name)}
              </span>
            )}
            {!recordingSkill && hasControl ? (
              computer?.takeoverRequested ? (
                <span className="rounded-full bg-warning/15 px-[11px] py-1 text-[13px] text-warning">
                  <Trans>Needs you</Trans>
                </span>
              ) : (
                <span className="rounded-full bg-success/15 px-[11px] py-1 text-[13px] text-success">
                  <Trans>You have control</Trans>
                </span>
              )
            ) : null}
          </div>
          <div className="flex items-center gap-3">
            {composerRunning ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={t`Stop`}
                data-testid="computer-overlay-stop"
                onClick={() => void onStopRun()}
                disabled={sending}
              >
                <Trans>Stop</Trans>
              </Button>
            ) : null}
            {recordingSkill ? (
              <TeachStopButton busy={teachBusy} onStop={onStopTeaching} />
            ) : hasControl ? (
              <ComputerReleaseActions
                takeoverRequested={Boolean(computer?.takeoverRequested)}
                onRelease={onRelease}
              />
            ) : computer?.state === "running" && !computerTakeoverBlocked(computer, runStatus) ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={booting}
                onClick={() => void onTakeControl()}
              >
                <Trans>Take control</Trans>
              </Button>
            ) : null}
            {!recordingSkill ? (
              <TeachComputerOverlayControl
                key={bot.id}
                botId={bot.id}
                computer={computer}
                busy={teachBusy}
                onRefresh={onRefreshTeaching}
              />
            ) : null}
            {!recordingSkill ? (
              <ComputerMaintenanceActions
                botId={bot.id}
                computer={computer}
                onChanged={async () => {
                  await onRefreshComputer();
                }}
              />
            ) : null}
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              aria-label={t`Close computer`}
              onClick={() => onClose()}
            >
              <X size={16} strokeWidth={1.8} />
            </Button>
          </div>
        </div>
        {sendError ? (
          <div
            role="alert"
            className="border-b border-destructive/40 bg-destructive/10 px-[18px] py-2 text-[13px] text-destructive"
          >
            {sendError}
          </div>
        ) : null}
        <div className="relative min-h-0 flex-1 bg-background">
          {computer?.kind === "desktop" ? (
            <DesktopKindEmptyState className="grid h-full place-items-center px-8 text-center text-sm text-muted-foreground/80" />
          ) : computer?.state === "running" && embeddedScreenUrl && !computerScreenError ? (
            <>
              <iframe
                key={screenFrameKey}
                title={t`Bot screen`}
                ref={screenFrameRef}
                src={embeddedScreenUrl}
                sandbox={screenIframeSandbox(embeddedScreenUrl)}
                className="h-full w-full border-0 bg-black"
                allow="clipboard-read; clipboard-write; fullscreen"
                style={{
                  pointerEvents: recordingSkill || !hasControl ? "none" : "auto",
                }}
              />
              {bot ? (
                <TeachCaptureOverlay
                  botId={bot.id}
                  skill={recordingSkill}
                  enabled={Boolean(recordingSkill)}
                  screenWidth={computer?.screenWidth}
                  screenHeight={computer?.screenHeight}
                />
              ) : null}
            </>
          ) : (
            <div className="grid h-full place-items-center text-sm text-muted-foreground/80">
              {computerScreenError ??
                computerBooting ??
                (computer?.state === "stopped" || computer?.state === "suspended" ? (
                  <div className="flex flex-col items-center gap-3">
                    <p>
                      {computer.state === "suspended"
                        ? t`Computer is asleep`
                        : t`Computer is stopped`}
                    </p>
                    <Button variant="outline" size="sm" onClick={onStart}>
                      <Trans>Start</Trans>
                    </Button>
                  </div>
                ) : (
                  computerLabel(computer?.mode, bot.name)
                ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
