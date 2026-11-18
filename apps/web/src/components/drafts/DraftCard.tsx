import { Trans, useLingui } from "@lingui/react/macro";
import type { DraftBlock } from "@rakazo/contracts";
import type { DraftNote } from "@rakazo/core";
import { Button } from "@rakazo/ui-web";
import { useState } from "react";
import { useCopyText } from "../../lib/copy-text";
import type { ArtifactTarget } from "../../lib/pages/artifact-open";
import { BuiCard } from "../ai/primitives";
import { DraftDialog, DraftHeading } from "./DraftDialog";

/**
 * Something the bot wrote for the user to send: a short preview to copy, or open to mark the
 * passages to change and have it revised. Notes belong to the version they were made on.
 */
export function DraftCard({
  block,
  messageId,
  target,
}: {
  block: DraftBlock;
  messageId: string;
  target: ArtifactTarget;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [marked, setMarked] = useState<{ version: number; notes: DraftNote[] }>({
    version: block.version,
    notes: [],
  });
  const notes = marked.version === block.version ? marked.notes : [];
  const [copied, copy] = useCopyText();
  return (
    <BuiCard data-testid="draft-card" className="w-[520px] max-w-full px-5 pt-4 pb-3">
      <button
        type="button"
        aria-label={t`Open ${block.label}`}
        onClick={() => setOpen(true)}
        className="block w-full cursor-pointer text-start outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <DraftHeading block={block} />
        {block.subject ? (
          <span className="mt-2 block truncate text-body font-medium" dir="auto">
            {block.subject}
          </span>
        ) : null}
        <span
          className="mt-2 line-clamp-4 whitespace-pre-wrap text-body text-foreground/90"
          dir="auto"
        >
          {block.body}
        </span>
      </button>
      <div className="mt-3 flex items-center justify-between">
        <Button variant="text" size="sm" className="-ms-2.5" onClick={() => void copy(block.body)}>
          {copied ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
        </Button>
        <Button variant="outline" size="sm" aria-haspopup="dialog" onClick={() => setOpen(true)}>
          <Trans>Open</Trans>
        </Button>
      </div>
      <DraftDialog
        open={open}
        onOpenChange={setOpen}
        block={block}
        messageId={messageId}
        target={target}
        notes={notes}
        onNotesChange={(next) => setMarked({ version: block.version, notes: next })}
      />
    </BuiCard>
  );
}
