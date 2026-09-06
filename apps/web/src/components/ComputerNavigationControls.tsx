import { Trans, useLingui } from "@lingui/react/macro";
import type { ComputerStatus } from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@rakazo/ui-web";
import {
  ArrowDownUp,
  Clipboard,
  Crosshair,
  HelpCircle,
  Keyboard,
  MousePointer2,
  Move,
  Scan,
  ZoomIn,
} from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";
import { ComputerMaintenanceActions } from "./ComputerMaintenanceActions";

const preferenceKey = "cadre:computer-trackpad";
export function ComputerNavigationControls({
  frameRef,
  screenUrl,
  enabled,
  botId,
  computer,
  onChanged,
}: {
  frameRef: RefObject<HTMLIFrameElement | null>;
  screenUrl: string | null;
  enabled: boolean;
  botId: string;
  computer: ComputerStatus | null;
  onChanged: () => Promise<void>;
}) {
  const { t } = useLingui();
  const [helpOpen, setHelpOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const [trackpad, setTrackpad] = useState(() => {
    try {
      return localStorage.getItem(preferenceKey) === "true";
    } catch {
      return false;
    }
  });
  const trackpadRef = useRef(trackpad);
  trackpadRef.current = trackpad;
  function command(action: "trackpad" | "recenter" | "resetZoom", value = trackpad) {
    // The viewer has an opaque sandbox origin. Only non-secret navigation
    // preferences cross this bridge; input remains on its existing RFB lease.
    frameRef.current?.contentWindow?.postMessage(
      { type: "cadre:computer-navigation", action, enabled: value },
      "*",
    );
  }
  useEffect(() => {
    setReady(false);
    const listener = (event: MessageEvent) => {
      if (
        event.source !== frameRef.current?.contentWindow ||
        event.data?.type !== "cadre:computer-navigation-ready"
      )
        return;
      setReady(true);
      frameRef.current?.contentWindow?.postMessage(
        { type: "cadre:computer-navigation", action: "trackpad", enabled: trackpadRef.current },
        "*",
      );
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [frameRef, screenUrl]);
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        aria-label={t`Using the computer`}
        className="shrink-0 rounded-full"
        onClick={() => setHelpOpen(true)}
      >
        <HelpCircle size={21} />
      </Button>
      <ComputerMaintenanceActions botId={botId} computer={computer} onChanged={onChanged}>
        <DropdownMenuCheckboxItem
          checked={trackpad}
          disabled={!enabled || !ready}
          onCheckedChange={(value) => {
            setTrackpad(value);
            command("trackpad", value);
            try {
              localStorage.setItem(preferenceKey, String(value));
            } catch {
              /* A blocked preference store does not block input. */
            }
          }}
        >
          <MousePointer2 size={17} />
          <Trans>Trackpad mode</Trans>
        </DropdownMenuCheckboxItem>
        <DropdownMenuItem disabled={!enabled || !ready} onClick={() => command("recenter")}>
          <Crosshair size={17} />
          <Trans>Recenter pointer</Trans>
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!enabled || !ready} onClick={() => command("resetZoom")}>
          <Scan size={17} />
          <Trans>Fit screen</Trans>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
      </ComputerMaintenanceActions>
      <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
        <DialogContent
          className="max-h-[85dvh] overflow-y-auto rounded-[28px] p-6 sm:max-w-lg"
          aria-describedby={undefined}
        >
          <DialogHeader>
            <DialogTitle>
              <Trans>Using the computer</Trans>
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-6 pt-3">
            <section aria-label={t`Moving around`}>
              <h3 className="mb-2 px-3 text-sm text-muted-foreground">
                <Trans>Moving around</Trans>
              </h3>
              <div className="divide-y divide-border rounded-3xl bg-muted/60">
                <HelpRow
                  icon={ArrowDownUp}
                  title={t`Scroll`}
                  text={t`Move two fingers up, down, or sideways.`}
                />
                <HelpRow
                  icon={Move}
                  title={t`Click and drag`}
                  text={t`Tap to click. Move one finger to drag an item.`}
                />
                <HelpRow
                  icon={MousePointer2}
                  title={t`Right-click`}
                  text={t`Tap with two fingers, or touch and hold.`}
                />
                <HelpRow
                  icon={ZoomIn}
                  title={t`Zoom`}
                  text={t`Pinch to zoom. While zoomed in, use two fingers to move around the screen. Choose Fit screen to zoom out.`}
                />
              </div>
            </section>
            <section aria-label={t`Typing and clipboard`}>
              <h3 className="mb-2 px-3 text-sm text-muted-foreground">
                <Trans>Typing and clipboard</Trans>
              </h3>
              <div className="divide-y divide-border rounded-3xl bg-muted/60">
                <HelpRow
                  icon={Keyboard}
                  title={t`Type`}
                  text={t`The keyboard button opens or hides your phone’s keyboard. On a computer, type normally.`}
                />
                <HelpRow
                  icon={Clipboard}
                  title={t`Copy and paste`}
                  text={t`Open the clipboard button to copy selected computer text or paste text into the computer.`}
                />
              </div>
            </section>
            <section aria-label={t`Trackpad mode`}>
              <h3 className="mb-2 px-3 text-sm text-muted-foreground">
                <Trans>Trackpad mode</Trans>
              </h3>
              <div className="rounded-3xl bg-muted/60">
                <HelpRow
                  icon={MousePointer2}
                  title={t`Move the pointer`}
                  text={t`Turn on Trackpad mode in the menu. Slide one finger to move the pointer and tap to click. Tap twice and hold the second touch to drag. Recenter pointer brings it back to the middle.`}
                />
              </div>
            </section>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
function HelpRow({
  icon: Icon,
  title,
  text,
}: {
  icon: typeof MousePointer2;
  title: string;
  text: string;
}) {
  return (
    <div className="flex gap-3 p-4">
      <Icon size={20} strokeWidth={1.7} className="mt-0.5 shrink-0 text-muted-foreground" />
      <div>
        <p className="font-medium">{title}</p>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{text}</p>
      </div>
    </div>
  );
}
