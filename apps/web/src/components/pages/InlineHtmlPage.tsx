import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";
import { pageFrameHeight } from "../../lib/page-cards";
import { PageFooter } from "./PageCard";
import { PageFrame } from "./PageFrame";

/**
 * Before the page reports its height, the frame gets a readable placeholder so it can draw and
 * measure rather than collapsing to nothing.
 */
const UNMEASURED_HEIGHT = 360;

/**
 * An HTML page in the chat, at the page's own height. The frame is interactive, so links and
 * copy buttons the page offers work there; the page's scripts already run in its sandbox.
 */
export function InlineHtmlPage({
  title,
  document,
  failed = false,
  onOpen,
}: {
  title: string;
  document: string | null;
  /** The page could not be read, so its placeholder stops looking like it is loading. */
  failed?: boolean;
  /** Opens the page full screen; absent once it is deleted. */
  onOpen?: () => void;
}) {
  const { t } = useLingui();
  const box = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const [live, setLive] = useState(false);
  // A page starts once it comes near view, so a long chat never runs every page it holds, and then
  // keeps running, so what the reader typed or toggled survives scrolling past it.
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") {
      setLive(true);
      return;
    }
    const near = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setLive(true);
        near.disconnect();
      },
      { rootMargin: "400px 0px" },
    );
    near.observe(element);
    return () => near.disconnect();
  }, []);
  return (
    <div
      ref={box}
      data-testid="inline-page"
      aria-busy={document === null && !failed ? true : undefined}
      className="w-full overflow-hidden rounded-[24px] bg-card ring-[0.5px] ring-border"
    >
      {document === null ? (
        <div className="flex min-h-[240px] items-center justify-center">
          {failed ? (
            <p className="px-6 text-center text-muted-foreground text-body">
              <Trans>This page couldn't load</Trans>
            </p>
          ) : (
            <div className="w-full animate-pulse px-6" aria-hidden="true">
              <div className="h-5 w-2/5 rounded-[6px] bg-foreground/[0.06]" />
              <div className="mt-3 h-3 w-3/5 rounded-[5px] bg-foreground/[0.05]" />
              <div className="mt-4 h-24 rounded-[8px] bg-foreground/[0.05]" />
            </div>
          )}
        </div>
      ) : (
        <>
          <div style={{ height: pageFrameHeight(height) || UNMEASURED_HEIGHT }}>
            {live ? (
              <PageFrame
                document={document}
                title={title}
                interactive
                onHeight={(next) => setHeight(pageFrameHeight(next))}
              />
            ) : null}
          </div>
          {onOpen ? (
            <button
              type="button"
              aria-label={t`Open ${title}`}
              onClick={onOpen}
              className="block w-full outline-none hover:bg-foreground/[0.02] focus-visible:ring-2 focus-visible:ring-ring"
            >
              <PageFooter title={title}>
                <Trans>Page</Trans>
              </PageFooter>
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
