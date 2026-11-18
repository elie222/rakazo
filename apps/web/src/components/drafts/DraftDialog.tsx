import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { DraftBlock } from "@rakazo/contracts";
import type { DraftNote } from "@rakazo/core";
import { addDraftNote, draftRevisionText, draftSegments, newClientId } from "@rakazo/core";
import { Button, Dialog, DialogClose, DialogContent, DialogTitle, Input } from "@rakazo/ui-web";
import { X } from "lucide-react";
import { useRef, useState } from "react";
import type { ArtifactTarget } from "../../lib/artifact-open";
import { useCopyText } from "../../lib/copy-text";
import { useSave } from "../../lib/query";
import { useEventListener } from "../../lib/use-event-listener";
import { errorDetails } from "../../lib/user-error";
import { ErrorNotice } from "../ErrorNotice";

const PANEL_WIDTH = 288;
/** Stands in for the note of a passage still being noted. */
const PENDING = "pending";

/** The draft's name, and who it is for when the bot said. */
export function DraftHeading({ block }: { block: DraftBlock }) {
  return (
    <span className="flex min-w-0 items-baseline gap-2 text-body-sm" dir="auto">
      <span className="shrink-0 font-medium text-foreground">{block.label}</span>
      {block.to ? <span className="truncate text-muted-foreground">{block.to}</span> : null}
    </span>
  );
}

type Panel =
  | { kind: "new"; start: number; end: number; top: number; left: number }
  | { kind: "note"; index: number; top: number; left: number };

/** Characters of `root`'s text before the boundary at `node`/`offset`. */
function textOffset(root: Node, node: Node, offset: number): number {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(node, offset);
  return range.toString().length;
}

/** Where a panel sits under `rect`, inside `frame`, centered on it where it fits. */
function panelPlace(rect: DOMRect, frame: HTMLElement) {
  const box = frame.getBoundingClientRect();
  const center = rect.left - box.left + rect.width / 2;
  return {
    top: rect.bottom - box.top + 8,
    left: Math.max(0, Math.min(center - PANEL_WIDTH / 2, box.width - PANEL_WIDTH)),
  };
}

/**
 * The whole draft, to mark up: select a passage and say what should change there, as many times
 * as needed, then Revise sends every note at once as a reply to the draft.
 */
export function DraftDialog({
  open,
  onOpenChange,
  block,
  messageId,
  target,
  notes,
  onNotesChange,
  onRevised,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  block: DraftBlock;
  messageId: string;
  target: ArtifactTarget;
  notes: readonly DraftNote[];
  onNotesChange: (notes: DraftNote[]) => void;
  onRevised: () => Promise<void>;
}) {
  const { t } = useLingui();
  const [copied, copy] = useCopyText();
  const [panel, setPanel] = useState<Panel | null>(null);
  const [noteText, setNoteText] = useState("");
  const frameRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const revise = useSave({
    save: (input: { text: string; clientNonce: string }, rpc) =>
      rpc.threads.send({
        ...target,
        text: input.text,
        replyToMessageId: messageId,
        clientNonce: input.clientNonce,
      }),
    closesScreen: true,
    onSaved: async () => {
      onNotesChange([]);
      onOpenChange(false);
      await onRevised();
    },
  });

  const closePanel = () => {
    setPanel(null);
    setNoteText("");
  };

  const readSelection = () => {
    const root = bodyRef.current;
    const frame = frameRef.current;
    const selection = window.getSelection();
    if (!root || !frame || !selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (range.collapsed || !root.contains(range.commonAncestorContainer)) return;
    const start = textOffset(root, range.startContainer, range.startOffset);
    const end = textOffset(root, range.endContainer, range.endOffset);
    // Only a passage a note could cover: not blank, and clear of the notes already there.
    if (!addDraftNote(block.body, notes, { start, end, note: PENDING })) return;
    setNoteText("");
    setPanel({ kind: "new", start, end, ...panelPlace(range.getBoundingClientRect(), frame) });
  };

  // A selection in the body offers a note; a click on a marked passage shows its note.
  const onBodyGesture = (event: PointerEvent | KeyboardEvent) => {
    if (event instanceof KeyboardEvent && !event.shiftKey) return;
    const root = bodyRef.current;
    const frame = frameRef.current;
    const target = event.target instanceof Node ? event.target : null;
    if (!root || !frame || !target || !root.contains(target)) return;
    if (!window.getSelection()?.isCollapsed) return readSelection();
    const mark = (target instanceof Element ? target : target.parentElement)?.closest<HTMLElement>(
      "mark[data-pin]",
    );
    const index = Number(mark?.dataset.pin) - 1;
    if (!mark || !(index >= 0)) return closePanel();
    setPanel({ kind: "note", index, ...panelPlace(mark.getBoundingClientRect(), frame) });
  };
  useEventListener(open ? document : null, "pointerup", onBodyGesture);
  useEventListener(open ? document : null, "keyup", onBodyGesture);

  const addNote = () => {
    if (panel?.kind !== "new") return;
    const next = addDraftNote(block.body, notes, { ...panel, note: noteText });
    if (!next) return;
    onNotesChange(next);
    window.getSelection()?.removeAllRanges();
    closePanel();
  };

  const pending =
    panel?.kind === "new" ? addDraftNote(block.body, notes, { ...panel, note: PENDING }) : null;
  const shown = pending ?? notes;
  const pendingIndex =
    panel?.kind === "new" ? shown.findIndex((note) => note.end > panel.start) : -1;
  const openNote = panel?.kind === "note" ? notes[panel.index] : undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={(next, details) => {
        // Escape with a note open closes the note, not the draft.
        if (!next && panel && details.reason === "escape-key") {
          details.cancel();
          closePanel();
          return;
        }
        if (!next) closePanel();
        onOpenChange(next);
      }}
    >
      <DialogContent
        size="md"
        showCloseButton={false}
        className="h-auto max-h-[min(760px,calc(100%-2rem))]"
      >
        <div className="flex items-center gap-2 border-b border-border px-5 py-3">
          <DialogTitle className="flex min-w-0 flex-1 text-body font-normal">
            <DraftHeading block={block} />
          </DialogTitle>
          <Button variant="text" size="sm" onClick={() => void copy(block.body)}>
            {copied ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
          </Button>
          <DialogClose aria-label={t`Close`} render={<Button variant="ghost" size="icon-sm" />}>
            <X />
          </DialogClose>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <div ref={frameRef} className="relative">
            {block.subject ? (
              <p className="mb-4 text-body-lg font-medium" dir="auto">
                {block.subject}
              </p>
            ) : null}
            <div
              ref={bodyRef}
              data-testid="draft-body"
              className="whitespace-pre-wrap text-body-lg text-foreground"
              dir="auto"
            >
              {draftSegments(block.body, shown).map((segment, index) => {
                if (segment.note === undefined) return <span key={index}>{segment.text}</span>;
                const isPending = segment.note === pendingIndex;
                const number = isPending ? undefined : notes.indexOf(shown[segment.note]!) + 1;
                return (
                  <mark
                    key={index}
                    data-pin={number}
                    className={
                      isPending
                        ? "rounded-sm bg-accent text-inherit"
                        : "cursor-pointer rounded-sm bg-accent text-inherit underline decoration-foreground/50 underline-offset-4 after:ms-0.5 after:inline-flex after:size-4 after:-translate-y-1.5 after:items-center after:justify-center after:rounded-full after:bg-foreground after:align-baseline after:text-caption after:leading-none after:font-medium after:text-background after:no-underline after:content-[attr(data-pin)]"
                    }
                  >
                    {segment.text}
                  </mark>
                );
              })}
            </div>
            {panel ? (
              <div
                data-testid="draft-note-panel"
                style={{ top: panel.top, left: panel.left, width: PANEL_WIDTH }}
                className="absolute z-10 flex flex-col gap-2 rounded-lg bg-popover p-2.5 text-body text-popover-foreground shadow-md ring-1 ring-foreground/10"
              >
                {panel.kind === "new" ? (
                  <form
                    className="flex items-center gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      addNote();
                    }}
                  >
                    <Input
                      autoFocus
                      aria-label={t`What should change?`}
                      placeholder={t`What should change?`}
                      value={noteText}
                      onChange={(event) => setNoteText(event.target.value)}
                    />
                    <Button type="submit" size="sm" disabled={!noteText.trim()}>
                      <Trans>Add</Trans>
                    </Button>
                  </form>
                ) : openNote ? (
                  <div className="flex items-start gap-2">
                    <p className="min-w-0 flex-1 py-1 wrap-anywhere" dir="auto">
                      {openNote.note}
                    </p>
                    <Button
                      variant="text"
                      size="sm"
                      autoFocus
                      onClick={() => {
                        onNotesChange(notes.filter((note) => note !== openNote));
                        closePanel();
                      }}
                    >
                      <Trans>Remove</Trans>
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-3 border-t border-border px-5 py-3">
          <div className="min-w-0 flex-1">
            {revise.error ? (
              <ErrorNotice error={errorDetails(revise.error, t`Could not send your notes`)} />
            ) : (
              <span className="text-body-sm text-muted-foreground">
                {notes.length
                  ? t`${plural(notes.length, { one: "# note", other: "# notes" })}`
                  : t`Select text to add a note`}
              </span>
            )}
          </div>
          <Button
            disabled={!notes.length || revise.pending}
            onClick={() =>
              revise.run({
                text: draftRevisionText(block.body, notes),
                clientNonce: newClientId(),
              })
            }
          >
            <Trans>Revise</Trans>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
