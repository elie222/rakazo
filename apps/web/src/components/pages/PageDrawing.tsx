import { useLingui } from "@lingui/react/macro";
import { useTimeout } from "@rakazo/chat-ui/hooks";
import type { PageSectionAnchor, PageState } from "@rakazo/contracts";
import { useCallback, useState } from "react";
import { PageFrame } from "./PageFrame";
import { PageLoading, PageNotice } from "./PageNotice";

/** How long a page may take to draw before the view offers to load it again. */
const FRAME_TIMEOUT_MS = 15_000;

export type PageDrawingState = ReturnType<typeof usePageDrawing>;

/**
 * Whether the page in `document` has drawn. The frame stays hidden until the page inside reports
 * it has, so neither a blank frame nor a browser error page shows; a page that never draws gets a
 * way to try again. A new document (an update, a theme change) has to draw again before it shows.
 */
export function usePageDrawing(document: string | null, waitingAllowed = true) {
  const [drawn, setDrawn] = useState(false);
  const [stalled, setStalled] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [shown, setShown] = useState(document);
  if (shown !== document) {
    setShown(document);
    setDrawn(false);
    setStalled(false);
  }
  const waiting = document !== null && !drawn && !stalled && waitingAllowed;
  useTimeout(() => setStalled(true), waiting ? FRAME_TIMEOUT_MS : null, document);
  const onDrawn = useCallback(() => setDrawn(true), []);
  const retry = useCallback(() => {
    setStalled(false);
    setAttempt((count) => count + 1);
  }, []);
  return { document, drawn, stalled, attempt, onDrawn, retry };
}

/** The page once it has drawn, a loading state until then, and a retry if it never does. */
export function PageDrawing({
  drawing,
  title,
  onReply,
  onSections,
  onSaveState,
  onClose,
}: {
  drawing: PageDrawingState;
  title: string;
  onReply?: (text: unknown) => void;
  onSections?: (sections: PageSectionAnchor[]) => void;
  onSaveState?: (values: PageState) => void;
  onClose?: () => void;
}) {
  const { t } = useLingui();
  const { document, drawn, stalled, attempt, onDrawn, retry } = drawing;
  return (
    <>
      {document !== null && !stalled ? (
        <div
          key={attempt}
          className={`h-full transition-opacity duration-200 motion-reduce:transition-none ${drawn ? "opacity-100" : "opacity-0"}`}
        >
          <PageFrame
            document={document}
            title={title}
            interactive
            onReply={onReply}
            onSections={onSections}
            onSaveState={onSaveState}
            onHeight={onDrawn}
          />
        </div>
      ) : null}
      {stalled ? (
        <PageNotice
          title={t`This page couldn't load`}
          detail={t`Check your connection and try again.`}
          onRetry={retry}
          onClose={onClose}
        />
      ) : !drawn ? (
        <PageLoading />
      ) : null}
    </>
  );
}
