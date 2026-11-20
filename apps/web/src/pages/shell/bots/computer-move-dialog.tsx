import { Trans } from "@lingui/react/macro";
import type { ComputerMode, ComputerMoveFiles } from "@rakazo/contracts";
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
import { useEffect, useRef } from "react";
import { useSpaceQueries } from "../../../lib/query/query";

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
  const move = useQuery({
    ...queries.bots.computerMove.queryOptions({ input: { botId, mode } }),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  // Until the answer is in, the files cannot be brought; without one, assume they replace some.
  const replaces = move.data?.replacesFiles ?? move.isError;
  // Bring files is the default answer, so it takes the focus as soon as it can be pressed.
  const bring = useRef<HTMLButtonElement>(null);
  const ready = !move.isPending;
  useEffect(() => {
    if (ready) bring.current?.focus();
  }, [ready]);
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
          <AlertDialogAction ref={bring} disabled={!ready} onClick={() => onChoose("bring")}>
            <Trans>Bring files</Trans>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
