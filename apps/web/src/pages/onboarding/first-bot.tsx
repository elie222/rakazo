import { Trans } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";

/** The bot step only renders when creating the first bot failed. */
export function FirstBotRetry({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  return (
    <div>
      <p className="text-body text-destructive">{error}</p>
      <Button className="mt-4" onClick={onRetry}>
        <Trans>Try again</Trans>
      </Button>
    </div>
  );
}
