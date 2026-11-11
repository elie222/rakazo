import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ComputerReleaseReason, ComputerStatus } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";

/** Who is using the screen, floating over it, with the hand-back when it is the viewer. */
export function ComputerControlPill({
  computer,
  hasControl,
  busyBotName,
  onFinish,
}: {
  computer: ComputerStatus;
  hasControl: boolean;
  /** The bot whose run is using the screen, so the viewer only watches. */
  busyBotName: string | null;
  onFinish: (reason?: ComputerReleaseReason) => void;
}) {
  const label = hasControl
    ? t`You’re in control`
    : computer.controlledByOther
      ? computer.controlledByName
        ? t`${computer.controlledByName} is in control`
        : t`Someone else is in control`
      : busyBotName
        ? t`${busyBotName} is working`
        : null;
  if (!label) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-4">
      <div
        data-testid="computer-control-pill"
        className={`pointer-events-auto flex items-center gap-3 rounded-full border border-border bg-background text-body text-foreground shadow-md ${
          hasControl ? "py-1.5 ps-4 pe-1.5" : "px-4 py-2"
        }`}
      >
        <span dir="auto">{label}</span>
        {hasControl && computer.takeoverRequested ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="rounded-full"
            onClick={() => onFinish("skipped")}
          >
            <Trans>Skip</Trans>
          </Button>
        ) : null}
        {hasControl ? (
          <Button
            type="button"
            size="sm"
            className="rounded-full"
            onClick={() => onFinish(computer.takeoverRequested ? "done" : undefined)}
          >
            <Trans>I’m done</Trans>
          </Button>
        ) : null}
      </div>
    </div>
  );
}
