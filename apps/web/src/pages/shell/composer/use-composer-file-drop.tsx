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
 * dropping them anywhere on it hands them to `onDropFiles`.
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
  // reports leaving the zone, so the drag ends when every one still in the zone was left.
  const entered = useRef(new Set<EventTarget>());
  // The source of a drag that started in the page: an image or link can carry files too, and only
  // files from outside attach. A source removed mid-drag cannot report its end, so it stops counting.
  const pageDragSource = useRef<Node | null>(null);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const reset = () => {
    entered.current.clear();
    setDraggingFiles(false);
  };
  const filesFromOutside = (event: DragEvent) =>
    !pageDragSource.current?.isConnected && isFileDrag(event.dataTransfer);

  useEventListener(window, "dragstart", (event) => {
    pageDragSource.current = event.target instanceof Node ? event.target : null;
  });
  // Drops elsewhere, and drags cancelled outside the column, end here.
  const endDrag = () => {
    pageDragSource.current = null;
    reset();
  };
  useEventListener(window, "dragend", endDrag);
  useEventListener(window, "drop", endDrag);

  useEventListener(zone, "dragenter", (event) => {
    if (!filesFromOutside(event)) return;
    event.preventDefault();
    if (disabled || !event.target) return reset();
    entered.current.add(event.target);
    setDraggingFiles(true);
  });
  useEventListener(zone, "dragover", (event) => {
    const dataTransfer = event.dataTransfer;
    if (!dataTransfer || !filesFromOutside(event)) return;
    event.preventDefault();
    dataTransfer.dropEffect = disabled ? "none" : "copy";
    if (disabled) return reset();
    setDraggingFiles(true);
  });
  useEventListener(zone, "dragleave", (event) => {
    if (!filesFromOutside(event)) return;
    if (disabled || !zone) return reset();
    const targets = entered.current;
    if (event.target) targets.delete(event.target);
    for (const target of targets) {
      if (!(target instanceof Node && zone.contains(target))) targets.delete(target);
    }
    if (targets.size === 0) setDraggingFiles(false);
  });
  useEventListener(zone, "drop", (event) => {
    const dataTransfer = event.dataTransfer;
    if (!dataTransfer || !filesFromOutside(event)) return;
    event.preventDefault();
    reset();
    if (!disabled) onDropFiles(dataTransfer.files);
  });

  // Docked, the overlay sits in the composer's own short row, which hands its children input.
  return draggingFiles && zone
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
}
