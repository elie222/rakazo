import { Trans, useLingui } from "@lingui/react/macro";
import type { ComputerStatus } from "@rakazo/contracts";
import { Button, toast } from "@rakazo/ui-web";
import { RotateCw } from "lucide-react";
import { useState } from "react";
import { computerUpdates } from "../lib/computer-updates";
import { errorText } from "../lib/user-error";
import { IconTooltip } from "./IconTooltip";

export function ComputerMaintenanceActions({
  botId,
  computer,
  onChanged,
  inline = false,
}: {
  botId: string;
  computer: ComputerStatus | null;
  onChanged: () => Promise<void>;
  inline?: boolean;
}) {
  const { t } = useLingui();
  const [pending, setPending] = useState(false);

  if (!computer?.canRestart || computer.state === "booting") return null;
  const disabled = pending || Boolean(computer.busyBotName);

  async function restart() {
    setPending(true);
    try {
      await computerUpdates.start(botId);
      await onChanged();
    } catch (err) {
      toast.error(errorText(err, t`Could not restart computer`));
    } finally {
      setPending(false);
    }
  }

  if (inline)
    return (
      <Button variant="outline" size="sm" disabled={disabled} onClick={() => void restart()}>
        <Trans>Restart computer</Trans>
      </Button>
    );

  return (
    <IconTooltip label={t`Restart computer`}>
      <Button
        variant="ghost"
        size="icon-sm"
        className="text-muted-foreground"
        data-testid="computer-restart-button"
        aria-label={t`Restart computer`}
        disabled={disabled}
        onClick={() => void restart()}
      >
        <RotateCw />
      </Button>
    </IconTooltip>
  );
}
