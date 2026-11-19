import { Trans } from "@lingui/react/macro";
import type { ComputerMode } from "@rakazo/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useSpaceQueries } from "../../../lib/query/query";

/** What happens to a bot's files when it moves to another computer. */
export type ComputerMoveFiles = "bring" | "leave";

/**
 * Asked when a bot is moved to `mode`: bring its files along, or start with none. Dismissing it
 * leaves the bot where it is.
 */
export function ComputerMoveDialog({
  botId,
  botName,
  mode,
  onChoose,
  onCancel,
}: {
  botId: string;
  botName: string;
  mode: ComputerMode;
  onChoose: (files: ComputerMoveFiles) => void;
  onCancel: () => void;
}) {
  const queries = useSpaceQueries();
  // Asked each time: what the other computer holds changes with every stay there.
  const replaces = useQuery({
    ...queries.bots.computerMove.queryOptions({ input: { botId, mode } }),
    staleTime: 0,
    gcTime: 0,
  }).data?.replacesFiles;
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="break-words">
            {mode === "dedicated" ? (
              <Trans>Bring {botName}'s files from the Team Computer?</Trans>
            ) : (
              <Trans>Bring {botName}'s files from its own computer?</Trans>
            )}
          </AlertDialogTitle>
          {replaces ? (
            <AlertDialogDescription>
              {mode === "dedicated" ? (
                <Trans>They replace the older files on its own computer.</Trans>
              ) : (
                <Trans>They replace the older files on the Team Computer.</Trans>
              )}
            </AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction variant="outline" onClick={() => onChoose("leave")}>
            <Trans>Start empty</Trans>
          </AlertDialogAction>
          <AlertDialogAction autoFocus onClick={() => onChoose("bring")}>
            <Trans>Bring files</Trans>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
