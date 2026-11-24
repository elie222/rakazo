import { Paperclip } from "lucide-react";
import { createContext, useContext, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isFileDrag } from "../../../lib/composer/pending-attachments";
import { useEventListener } from "../../../lib/use-event-listener";

/** The chat column: files dropped anywhere on it attach to its composer. */
export const FileDropZoneContext = createContext<HTMLElement | null>(null);

/**
 * Files dragged in from outside the page over the chat column, or over the composer itself while
 * it is docked over an open page. While they are over it that area shows a drop overlay, and
 * dropping them anywhere on it hands them to `onDropFiles`. `fileDragActive` is true while such a
 * drag is anywhere over the window, so the composer's gaps can catch the drop.
 */
export function useComposerFileDrop({
  docked,
  composer,
  disabled,
  onDropFiles,
}: {
  docked: boolean;
  composer: HTMLElement | null;
  disabled?: boolean;
  onDropFiles: (files: FileList) => void;
}) {
  const chatColumn = useContext(FileDropZoneContext);
  const zone = docked ? composer : chatColumn;
  // The elements the drag is over. A node replaced under the cursor (a streaming reply) never
  // reports leaving, so one no longer in the page stops counting.
  const entered = useRef(new Set<Node>());
  const [dragTargets, setDragTargets] = useState<readonly Node[]>([]);
  // The source of a drag that started in the page: an image or link can carry files too, and only
  // files from outside attach. A source removed mid-drag cannot report its end, so it stops counting.
  const pageDragSource = useRef<Node | null>(null);
  const filesFromOutside = (event: DragEvent) =>
    !pageDragSource.current?.isConnected && isFileDrag(event.dataTransfer);
  const reset = () => {
    entered.current.clear();
    setDragTargets([]);
  };

  useEventListener(window, "dragstart", (event) => {
    pageDragSource.current = event.target instanceof Node ? event.target : null;
  });
  // Drops elsewhere, and drags cancelled outside the window, end here.
  const endDrag = () => {
    pageDragSource.current = null;
    reset();
  };
  useEventListener(window, "dragend", endDrag);
  useEventListener(window, "drop", endDrag);
  useEventListener(window, "dragenter", (event) => {
    if (!filesFromOutside(event) || !(event.target instanceof Node)) return;
    if (zone?.contains(event.target)) event.preventDefault();
    entered.current.add(event.target);
    setDragTargets([...entered.current]);
  });
  useEventListener(window, "dragleave", (event) => {
    if (!filesFromOutside(event)) return;
    const targets = entered.current;
    if (event.target instanceof Node) targets.delete(event.target);
    for (const target of targets) if (!target.isConnected) targets.delete(target);
    setDragTargets([...targets]);
  });

  useEventListener(zone, "dragover", (event) => {
    const dataTransfer = event.dataTransfer;
    if (!dataTransfer || !filesFromOutside(event)) return;
    event.preventDefault();
    dataTransfer.dropEffect = disabled ? "none" : "copy";
  });
  useEventListener(zone, "drop", (event) => {
    const dataTransfer = event.dataTransfer;
    if (!dataTransfer || !filesFromOutside(event)) return;
    event.preventDefault();
    reset();
    if (!disabled) onDropFiles(dataTransfer.files);
  });

  const overZone =
    !disabled && zone !== null && dragTargets.some((target) => zone.contains(target));
  // Docked, the overlay sits in the composer's own short row, which hands its children input.
  const fileDropOverlay =
    overZone && zone
      ? createPortal(
          <div
            aria-hidden="true"
            data-testid="file-drop-overlay"
            className={`pointer-events-none! absolute z-40 grid place-items-center border-2 border-dashed border-ring bg-background/80 ${
              docked ? "inset-0 rounded-[14px]" : "inset-2 rounded-2xl"
            }`}
          >
            {docked ? (
              <Paperclip size={16} strokeWidth={1.8} className="text-muted-foreground" />
            ) : (
              <span className="grid size-12 place-items-center rounded-full bg-muted text-muted-foreground">
                <Paperclip size={20} strokeWidth={1.8} />
              </span>
            )}
          </div>,
          zone,
        )
      : null;
  return { fileDragActive: dragTargets.length > 0, fileDropOverlay };
}
