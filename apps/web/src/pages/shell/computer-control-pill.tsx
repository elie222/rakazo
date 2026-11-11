import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ComputerReleaseReason, ComputerStatus } from "@rakazo/contracts";
import { computerControlUser } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";

/** Who is using the screen, floating over it, with the hand-back when it is the viewer. */
export function ComputerControlPill({
  computer,
  botId,
  busyBotName,
  onFinish,
}: {
  computer: ComputerStatus;
  botId: string;
  /** The bot whose run is using the screen, so the viewer only watches. */
  busyBotName: string | null;
  onFinish: (reason?: ComputerReleaseReason) => void;
}) {
  const user = computerControlUser(computer, botId, busyBotName);
  if (!user) return null;
  const hasControl = user.by === "you";
  const label =
    user.by === "you"
      ? t`You’re in control`
      : user.by === "youWithBot"
        ? t`You’re using it with ${user.name}`
        : user.by === "bot"
          ? t`${user.name} is working`
          : user.name
            ? t`${user.name} is in control`
            : t`Someone else is in control`;
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
