import { Trans, useLingui } from "@lingui/react/macro";
import { useTimeout } from "@rakazo/chat-ui/hooks";
import type { PageVisibility } from "@rakazo/contracts";
import { pageSharingLabel } from "@rakazo/i18n/page-review";
import type { CSSProperties } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatRelativeTime } from "../../lib/locale/relative-time";
import { PageFrame } from "./PageFrame";
import { PageTileIcon } from "./page-icon";

/** Pages draw at desktop width and shrink into the card, so a preview reads like the page. */
// Large enough that the preview's body text stays readable, not grey texture.
const PREVIEW_SCALE = 0.75;
const PREVIEW_ASPECT = 630 / 1200;
const FRAME_SIZE = `${100 / PREVIEW_SCALE}%`;
const SCROLL_HINT_IDLE_MS = 250;

/** The nearest ancestor that scrolls, so "near view" is measured along the chat, not the window. */
function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let at = element.parentElement; at; at = at.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(at).overflowY)) return at;
  }
  return null;
}

/** Previews kept running after they leave view, so scrolling back shows them drawn. */
const LIVE_PREVIEWS = 24;
const livePreviews = new Map<object, { near: boolean; drop: () => void }>();

/**
 * The card's native scrollport owns the scroll position. Its spacer uses the reported document
 * height, while the inert frame always lays out at the size of the visible preview.
 */
function PagePreview({
  document,
  title,
  failed,
  onOpen,
}: {
  document: string | null;
  title: string;
  failed: boolean;
  onOpen: () => void;
}) {
  const { t } = useLingui();
  const box = useRef<HTMLDivElement>(null);
  const scrollport = useRef<HTMLElement>(null);
  const spacer = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState(false);
  const [pageHeight, setPageHeight] = useState<number | null>(null);
  const [scroll, setScroll] = useState({ top: 0, max: 0 });
  const [lastScroll, setLastScroll] = useState<number | null>(null);
  const drawn = pageHeight !== null;
  const canScroll = drawn && scroll.max > 1;
  const hideFade = drawn && scroll.max - scroll.top <= 1;

  useTimeout(
    () => setLastScroll(null),
    lastScroll === null ? null : SCROLL_HINT_IDLE_MS,
    lastScroll,
  );

  const readScroll = useCallback((element: HTMLElement) => {
    const top = element.scrollTop;
    const max = element.scrollHeight - element.clientHeight;
    setScroll((previous) =>
      top === previous.top && max === previous.max ? previous : { top, max },
    );
  }, []);

  useEffect(() => {
    const element = scrollport.current;
    const tail = spacer.current;
    if (!drawn || !element || !tail) return;
    const observer = new ResizeObserver(() => readScroll(element));
    observer.observe(element);
    observer.observe(tail);
    return () => observer.disconnect();
  }, [drawn, readScroll]);

  useEffect(() => {
    setPageHeight(null);
    if (scrollport.current) scrollport.current.scrollTop = 0;
  }, [document]);

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const key = {};
    const drop = () => {
      livePreviews.delete(key);
      setLive(false);
      setPageHeight(null);
      setScroll({ top: 0, max: 0 });
    };
    const near = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        if (!entry.isIntersecting) {
          const preview = livePreviews.get(key);
          if (preview) preview.near = false;
          return;
        }
        livePreviews.delete(key);
        livePreviews.set(key, { near: true, drop });
        setLive(true);
        let over = livePreviews.size - LIVE_PREVIEWS;
        for (const [other, preview] of livePreviews) {
          if (over <= 0) break;
          if (other === key || preview.near) continue;
          preview.drop();
          over--;
        }
      },
      { root: scrollParent(element), rootMargin: "400px 0px" },
    );
    near.observe(element);
    return () => {
      near.disconnect();
      livePreviews.delete(key);
    };
  }, []);
  const openPreview = (
    <button
      type="button"
      aria-hidden="true"
      tabIndex={-1}
      className="absolute inset-0 hidden pointer-fine:pointer-events-auto pointer-fine:block pointer-fine:cursor-pointer"
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        scrollport.current?.focus({ preventScroll: true });
        onOpen();
      }}
    />
  );

  return (
    <div
      ref={box}
      // A touch tablet card shows at least 335px of page however narrow the chat makes it.
      className="pointer-events-none relative w-full overflow-hidden bg-card pointer-coarse:min-[900px]:min-h-[335px]"
      style={
        {
          aspectRatio: `${1 / PREVIEW_ASPECT}`,
          "--page-preview-height": `${Math.ceil((pageHeight ?? 0) * PREVIEW_SCALE)}px`,
          "--page-preview-frame-size": FRAME_SIZE,
          "--page-preview-touch-height": `calc(${FRAME_SIZE} + ${13 / PREVIEW_SCALE}px)`,
        } as CSSProperties
      }
    >
      <section
        ref={scrollport}
        data-testid="page-card-preview"
        data-page-preview-scroll={canScroll ? "" : undefined}
        data-scrolling={lastScroll !== null || undefined}
        aria-label={canScroll ? t`Preview of ${title}` : undefined}
        tabIndex={canScroll ? 0 : -1}
        onScroll={(event) => {
          readScroll(event.currentTarget);
          setLastScroll(event.timeStamp);
        }}
        className="rk-scroll rk-page-preview absolute inset-0 overflow-hidden focus-visible:-outline-offset-2 pointer-fine:pointer-events-auto pointer-fine:overflow-y-auto"
      >
        <div className="sticky top-0 h-full overflow-clip">
          {live && document !== null ? (
            <div
              inert
              // Touch tablets start the preview 13px further up the page.
              className="absolute top-0 left-0 h-(--page-preview-touch-height) w-(--page-preview-frame-size) origin-top-left pointer-coarse:min-[900px]:-top-[13px] pointer-fine:h-(--page-preview-frame-size)"
              style={{ transform: `scale(${PREVIEW_SCALE})` }}
            >
              <PageFrame
                document={document}
                title={title}
                onHeight={setPageHeight}
                previewScrollTop={scroll.top / PREVIEW_SCALE}
              />
            </div>
          ) : null}
          {drawn ? null : (
            // The page's shape until it draws, so the card never sits empty; still once it can't load.
            <div
              className={`pointer-events-none absolute inset-0 flex flex-col gap-3 bg-card px-6 pt-6 ${failed ? "" : "motion-safe:animate-pulse"}`}
            >
              <div className="h-5 w-2/5 rounded-[6px] bg-foreground/[0.06]" />
              <div className="h-3 w-3/5 rounded-[5px] bg-foreground/[0.05]" />
              <div className="mt-2 grid grid-cols-3 gap-2">
                <div className="h-12 rounded-sm bg-foreground/[0.05]" />
                <div className="h-12 rounded-sm bg-foreground/[0.05]" />
                <div className="h-12 rounded-sm bg-foreground/[0.05]" />
              </div>
              {failed ? (
                <p className="text-center text-muted-foreground text-body">{t`This page couldn't load`}</p>
              ) : null}
            </div>
          )}
          <div
            data-testid="page-card-preview-fade"
            data-at-end={hideFade || undefined}
            className="pointer-events-none absolute inset-x-0 bottom-0 h-[100px] bg-linear-to-b from-transparent to-card pointer-fine:data-at-end:hidden"
          />
          {canScroll && openPreview}
        </div>
        <div
          ref={spacer}
          aria-hidden="true"
          className="hidden h-[max(0px,calc(var(--page-preview-height)_-_100%))] pointer-fine:block"
        />
      </section>
    </div>
  );
}

/** A page in the chat: its live top and a footer naming it. The whole card opens the page. */
export function PageCard({
  title,
  document,
  onOpen,
  updated = false,
  updatedAt,
  visibility,
  failed = false,
}: {
  title: string;
  /** When the page last changed, said under its title. */
  updatedAt?: string;
  visibility?: PageVisibility;
  document: string | null;
  /** The page could not be read, so its preview stops looking like it is loading. */
  failed?: boolean;
  /** Absent once the page is deleted: the card stays in the chat and opens nothing. */
  onOpen?: () => void;
  /** A newer version of this page appears further down the chat. */
  updated?: boolean;
}) {
  const { t } = useLingui();
  const when = updatedAt ? formatRelativeTime(updatedAt) : "";
  const sharing = pageSharingLabel(visibility);
  return (
    <div
      data-testid="page-card"
      data-deleted={onOpen === undefined || undefined}
      className="group/page-card relative w-full max-w-[561px] overflow-hidden pointer-coarse:min-[900px]:max-w-[639px] rounded-[24px] bg-card ring-[0.5px] ring-border has-focus-visible:ring-2 has-focus-visible:ring-ring data-deleted:bg-transparent data-deleted:opacity-70"
    >
      {onOpen ? (
        <PagePreview document={document} title={title} failed={failed} onOpen={onOpen} />
      ) : null}
      <div
        className={`flex h-[73px] items-center gap-[14px] border-t border-foreground/[0.04] px-5 pointer-fine:group-has-[[data-page-preview-scroll]]/page-card:relative ${onOpen ? "motion-safe:transition-colors pointer-fine:group-hover/page-card:bg-foreground/[0.045] pointer-fine:has-focus-visible:bg-foreground/[0.045]" : ""}`}
      >
        <PageTileIcon />
        <div className="min-w-0">
          <div className="relative top-[1px] truncate text-body-lg leading-[21px] text-foreground">
            {title}
          </div>
          <div className="truncate text-body text-muted-foreground">
            {onOpen === undefined ? (
              <Trans>Page · Deleted</Trans>
            ) : updated ? (
              <Trans>Page · Updated below</Trans>
            ) : when ? (
              sharing ? (
                <Trans>
                  Page · {sharing} · {when}
                </Trans>
              ) : (
                <Trans>Page · {when}</Trans>
              )
            ) : (
              <Trans>Page</Trans>
            )}
          </div>
        </div>
        {onOpen ? (
          <button
            type="button"
            aria-label={t`Open ${title}`}
            onClick={onOpen}
            className="absolute inset-0 rounded-[24px] outline-none pointer-fine:cursor-pointer forced-colors:focus-visible:outline-2 forced-colors:focus-visible:-outline-offset-2 forced-colors:focus-visible:outline-solid"
          />
        ) : null}
      </div>
    </div>
  );
}
