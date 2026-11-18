import { Trans } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
import { Dialog, DialogContent, DialogTitle } from "@rakazo/ui-web";
import { useRef } from "react";
import { AgentImportForm } from "./agent-import";

/** The import in its own dialog: it makes a new bot, so it belongs to no open bot's panel. */
export function AgentImportDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (bot: Bot) => void;
}) {
  const creating = useRef(false);
  return (
    <Dialog
      open
      // A stray click outside must not throw away a pasted reply or a read in progress.
      disablePointerDismissal
      onOpenChange={(next) => {
        // Escape waits too while the bot is being created.
        if (!next && !creating.current) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        size="md"
        className="bg-card"
        data-testid="agent-import-dialog"
      >
        <DialogTitle className="sr-only">
          <Trans>Import an agent</Trans>
        </DialogTitle>
        <AgentImportForm
          onClose={onClose}
          onCreated={onCreated}
          onCreatingChange={(next) => {
            creating.current = next;
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
