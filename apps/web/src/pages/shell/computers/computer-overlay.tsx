import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type {
  Bot,
  ComputerElement,
  ComputerReleaseReason,
  ComputerStatus,
  TaughtSkill,
} from "@rakazo/contracts";
import { computerPreviewPlaceholder } from "@rakazo/i18n/computer-preview";
import { computerLabel } from "@rakazo/i18n/computer-usage";
import { BotAvatar, Button, Input } from "@rakazo/ui-web";
import { Search, X, ZoomIn } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { SaveScreenshotButton } from "../../../components/computers/SaveScreenshotButton";
import { TeachCaptureOverlay } from "../../../components/teach/TeachCaptureOverlay";
import { TeachComputerOverlayControl } from "../../../components/teach/TeachComputerOverlay";
import {
  TeachRecordingChrome,
  TeachStopButton,
} from "../../../components/teach/TeachRecordingChrome";
import { runsOnUserMachine } from "../../../lib/computers/computer-sandbox";
import { screenFrames, screenIframeSandbox } from "../../../lib/computers/computer-screen";
import {
  DARWIN_WINDOW_CONTROLS_WIDTH_PX,
  desktopBridge,
  windowChromeKind,
} from "../../../lib/platform/desktop";
import { useSave } from "../../../lib/query/query";
import { ComputerReleaseActions } from "./computer-release-actions";
import { DesktopKindEmptyState } from "./computer-view";

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
  sendError: string | null;
  embeddedScreenUrl: string | null;
  /** Changes to load the screen again in a new frame. */
  screenFrameKey?: string;
  heldScreen?: { url: string; key: string } | null;
  screenFrameRef: (frame: HTMLIFrameElement | null) => void;
  computerScreenError: ReactNode;
  computerBooting: ReactNode;
  onStopTeaching: () => void | Promise<void>;
  onStopRun: () => void;
  onRelease: (reason?: ComputerReleaseReason) => Promise<void>;
  onTakeControl: () => void;
  onStart: () => void;
  onRefreshTeaching: () => Promise<void>;
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
  sendError,
  embeddedScreenUrl,
  screenFrameKey,
  heldScreen,
  screenFrameRef,
  computerScreenError,
  computerBooting,
  onStopTeaching,
  onStopRun,
  onRelease,
  onTakeControl,
  onStart,
  onRefreshTeaching,
  onClose,
}: ComputerOverlayProps) {
  // The picture is taken on the server from the running computer, so it does not wait for the frame
  // to connect; a user's own machine has no screen here to take.
  const canSaveScreenshot = !runsOnUserMachine(computer) && computer?.state === "running";
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ComputerElement[]>([]);
  const [zoomImage, setZoomImage] = useState<string | null>(null);
  const find = useSave({
    save: async (text: string, rpc) => {
      const result = await rpc.computer.find({ botId: bot.id, text, limit: 30 });
      // The screen never answered, so an empty list would read as "no match" instead of a failure.
      if (result.unknown) throw new Error(t`The screen did not answer in time.`);
      return result;
    },
    onSaved: (result) => {
      setResults(result.elements);
    },
  });
  const zoom = useSave({
    save: (region: { x: number; y: number; w: number; h: number }, rpc) =>
      rpc.computer.zoom({ botId: bot.id, region }),
    onSaved: (result) => setZoomImage(result.image),
  });
  const click = useSave({
    save: (element: ComputerElement, rpc) =>
      rpc.computer.input({
        botId: bot.id,
        kind: "pointer",
        payload: { x: element.point.x, y: element.point.y, type: "click" },
      }),
    onSaved: () => {
      setFindOpen(false);
      setResults([]);
      setQuery("");
    },
  });

  function toggleFind() {
    setFindOpen((open) => !open);
    find.reset();
    if (findOpen) {
      setResults([]);
      setQuery("");
    }
  }

  function runFind() {
    const text = query.trim();
    if (!text || find.pending) return;
    find.run(text);
  }

  function chooseTarget(element: ComputerElement) {
    if (!click.pending) click.run(element);
  }

  function runZoom() {
    if (!zoom.pending) zoom.run({ x: 320, y: 200, w: 640, h: 400 });
  }

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
          style={
            windowChromeKind(desktopBridge()) === "darwin"
              ? { paddingLeft: DARWIN_WINDOW_CONTROLS_WIDTH_PX + 18 }
              : undefined
          }
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
              <span className="truncate text-body-lg font-medium text-foreground" dir="auto">
                {computerLabel(computer?.mode, bot.name)}
              </span>
            )}
            {!recordingSkill && hasControl && computer?.shared ? (
              <span
                data-testid="computer-shared-browser"
                className="min-w-0 truncate text-body-sm text-muted-foreground"
              >
                <Trans>Sites you sign in to stay signed in for everyone in this space</Trans>
              </span>
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
            ) : computer?.state === "running" ? (
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
            {!recordingSkill && !runsOnUserMachine(computer) && computer?.state === "running" ? (
              <>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground"
                  aria-label={t`Find on screen`}
                  data-testid="computer-find-open"
                  onClick={toggleFind}
                >
                  <Search size={16} strokeWidth={1.8} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground"
                  aria-label={t`Zoom into screen`}
                  data-testid="computer-zoom"
                  disabled={zoom.pending}
                  onClick={() => void runZoom()}
                >
                  <ZoomIn size={16} strokeWidth={1.8} />
                </Button>
              </>
            ) : null}
            {canSaveScreenshot ? (
              <SaveScreenshotButton key={`screenshot-${bot.id}`} botId={bot.id} />
            ) : null}
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              data-computer-close=""
              aria-label={t`Close computer`}
              onClick={() => onClose()}
            >
              <X size={16} strokeWidth={1.8} />
            </Button>
          </div>
        </div>
        {findOpen ? (
          <div
            data-testid="computer-find"
            className="border-b border-sidebar-border bg-background px-[18px] py-3"
          >
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void runFind();
              }}
            >
              <Input
                autoFocus
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  find.reset();
                }}
                placeholder={t`Find a control`}
                aria-label={t`Find a control`}
                className="max-w-sm"
              />
              <Button
                type="submit"
                variant="outline"
                size="sm"
                disabled={find.pending || query.trim() === ""}
              >
                {find.pending ? t`Finding…` : <Trans>Find</Trans>}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t`Close find`}
                onClick={toggleFind}
              >
                <X size={16} strokeWidth={1.8} />
              </Button>
            </form>
            {find.error || click.error ? (
              <p role="alert" className="mt-2 text-body-sm text-destructive">
                {find.error?.message ?? click.error?.message}
              </p>
            ) : null}
            {results.length > 0 ? (
              <ul className="mt-2 flex max-h-40 flex-col gap-1 overflow-auto">
                {results.map((element) => (
                  <li
                    key={`${element.role ?? ""}:${element.name ?? ""}:${element.point.x}:${element.point.y}`}
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="w-full justify-start gap-2"
                      disabled={click.pending}
                      onClick={() => chooseTarget(element)}
                    >
                      <span className="truncate">{element.name || element.role || t`Control`}</span>
                      {element.role ? (
                        <span className="text-muted-foreground">{element.role}</span>
                      ) : null}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        {zoom.error ? (
          <div
            role="alert"
            className="border-b border-destructive/40 bg-destructive/10 px-[18px] py-2 text-body-sm text-destructive"
          >
            {zoom.error.message}
          </div>
        ) : null}
        {sendError ? (
          <div
            role="alert"
            className="border-b border-destructive/40 bg-destructive/10 px-[18px] py-2 text-body-sm text-destructive"
          >
            {sendError}
          </div>
        ) : null}
        <div className="relative min-h-0 flex-1 bg-background">
          {runsOnUserMachine(computer) ? (
            <DesktopKindEmptyState className="grid h-full place-items-center px-8 text-center text-body text-muted-foreground/80" />
          ) : computer?.state === "running" && embeddedScreenUrl && !computerScreenError ? (
            <>
              {screenFrames(screenFrameKey, embeddedScreenUrl, heldScreen).map((frame) => (
                <iframe
                  key={frame.key}
                  title={frame.held ? undefined : t`Bot screen`}
                  aria-hidden={frame.held || undefined}
                  tabIndex={frame.held ? -1 : undefined}
                  ref={frame.held ? undefined : screenFrameRef}
                  src={frame.url}
                  sandbox={screenIframeSandbox(frame.url)}
                  className={`h-full w-full border-0 bg-black${frame.held ? " absolute inset-0" : ""}`}
                  allow="clipboard-read; clipboard-write; fullscreen"
                  style={{
                    pointerEvents: frame.held || recordingSkill || !hasControl ? "none" : "auto",
                  }}
                />
              ))}
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
            <div className="grid h-full place-items-center text-body text-muted-foreground/80">
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
                  computerPreviewPlaceholder(computer?.state, false)
                ))}
            </div>
          )}
        </div>
      </div>
      {zoomImage ? (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-overlay/80 p-6"
          role="dialog"
          aria-modal="true"
          aria-label={t`Zoomed screen`}
        >
          <div className="relative max-h-full max-w-full overflow-auto rounded-xl bg-background shadow-xl">
            <img src={zoomImage} alt={t`Zoomed screen`} className="block max-h-[80vh] max-w-full" />
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute end-2 top-2"
              aria-label={t`Close zoom`}
              onClick={() => setZoomImage(null)}
            >
              <X size={16} strokeWidth={1.8} />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
