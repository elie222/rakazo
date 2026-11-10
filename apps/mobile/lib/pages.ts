import type { PageDetail, PageVisibility } from "@rakazo/contracts";
import { isServerUnreachable, pageViewerDocument } from "@rakazo/core";
import { rpc } from "./api";
import { getActiveUiLocale } from "./i18n";
import { loadPageRuntime } from "./page-runtime";
import { registerSessionDiskCache } from "./session";

/** Pages draw at desktop width and shrink into the card, so a preview reads like the page. */
const PAGE_PREVIEW_SCALE = 0.6;
const PAGE_PREVIEW_ASPECT = 630 / 1200;

/** The card's live preview: the page laid out at `frame` size, scaled from its top-left corner. */
export function pagePreviewLayout(cardWidth: number) {
  const height = cardWidth * PAGE_PREVIEW_ASPECT;
  return {
    height,
    frameWidth: cardWidth / PAGE_PREVIEW_SCALE,
    frameHeight: height / PAGE_PREVIEW_SCALE,
    scale: PAGE_PREVIEW_SCALE,
  };
}

type PageCardState =
  | { status: "loading"; title: string }
  | { status: "failed"; title: string }
  | { status: "deleted"; title: string }
  | { status: "ready"; title: string; detail: PageDetail };

/** What a page block in the chat shows: the page's current title; the card opens the latest. */
export function pageCardState(
  block: { version: number; title: string },
  detail: PageDetail | null | "failed" | "deleted",
): PageCardState {
  if (detail === "failed" || detail === "deleted") return { status: detail, title: block.title };
  if (!detail) return { status: "loading", title: block.title };
  return {
    status: "ready",
    title: detail.title,
    detail,
  };
}

/** Why a page could not be read: it is gone, the server is out of reach, or anything else. */
export function pageLoadProblem(error: unknown): "gone" | "offline" | "failed" {
  if (pageReadFailure(error) === "deleted") return "gone";
  return isServerUnreachable(error) ? "offline" : "failed";
}

/** A card whose page is gone stays calm and opens nothing; any other failure may pass. */
export function pageReadFailure(error: unknown): "deleted" | "failed" {
  return (error as { code?: unknown } | null)?.code === "NOT_FOUND" ? "deleted" : "failed";
}

/** How long after a tap on a page it may still copy or open a link, as a browser's activation. */
const PAGE_ACTION_WINDOW_MS = 1_000;
/** Points a finger may drift and still tap; further is a scroll or a drag. */
const PAGE_TAP_SLOP = 10;

type PageTouch = { pageX: number; pageY: number };

/**
 * Where a touch on a page started, while it can still end as a tap: past the slop it is a scroll
 * or a drag, which a browser never counts as the person acting either.
 */
export function pageTapStart(start: PageTouch | null, touch: PageTouch): PageTouch | null {
  if (!start) return null;
  const moved = Math.hypot(touch.pageX - start.pageX, touch.pageY - start.pageY);
  return moved <= PAGE_TAP_SLOP ? start : null;
}

/** A page acts for the person only right after they tapped it, never on load or on its own. */
export function pageActionAllowed(tappedAt: number | null, now: number): boolean {
  return tappedAt !== null && now >= tappedAt && now - tappedAt <= PAGE_ACTION_WINDOW_MS;
}

/** The chat a page was made in, where its reply buttons write; null once that chat is gone. */
export function pageChat(page: Pick<PageDetail, "botId" | "groupId">) {
  if (page.groupId) return { pathname: "/group-thread", key: "groupId", threadKey: page.groupId };
  if (page.botId) return { pathname: "/thread", key: "botId", threadKey: page.botId };
  return null;
}

type PageReply = { text: string; page: { id: string; title: string } };
let pendingReply: (PageReply & { threadKey: string }) | null = null;

/** A reply tapped on a full-screen page waits for its chat's composer; the user still sends it. */
export function offerPageReply(threadKey: string, reply: PageReply) {
  pendingReply = { threadKey, ...reply };
}

/** The reply waiting for this chat, with the page it is about, taken once. */
export function takePageReply(threadKey: string | undefined): PageReply | null {
  if (!threadKey || pendingReply?.threadKey !== threadKey) return null;
  const { text, page } = pendingReply;
  pendingReply = null;
  return { text, page };
}

/** A message a page's kit posted through the WebView; anything unreadable is null. */
export function pageMessage(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

type PageShareState = {
  /** Null when a change's answer was lost and the server could not be asked since. */
  visibility: PageVisibility | null;
  shareUrl: string | null;
  /** The visibility being saved; the sheet shows it until the server answers. */
  pending: PageVisibility | null;
  error: boolean;
};

type PageShareEvent =
  | { type: "loaded"; visibility: PageVisibility; shareUrl: string | null }
  | { type: "choose"; visibility: PageVisibility }
  | { type: "saved"; visibility: PageVisibility; shareUrl: string | null }
  | {
      type: "failed";
      visibility: PageVisibility;
      /** What the server says now: the change may have been made with only its answer lost. */
      actual: Pick<PageDetail, "visibility" | "shareUrl"> | null;
    };

export function pageShareState(
  detail: Pick<PageDetail, "visibility" | "shareUrl">,
): PageShareState {
  return { visibility: detail.visibility, shareUrl: detail.shareUrl, pending: null, error: false };
}

/** A late answer for a choice the user already changed is ignored. */
export function reducePageShare(state: PageShareState, event: PageShareEvent): PageShareState {
  switch (event.type) {
    case "loaded":
      return pageShareState(event);
    case "choose":
      if (event.visibility === (state.pending ?? state.visibility)) return state;
      return { ...state, pending: event.visibility, error: false };
    case "saved":
      return state.pending === event.visibility ? pageShareState(event) : state;
    case "failed":
      if (state.pending !== event.visibility) return state;
      return {
        visibility: event.actual?.visibility ?? null,
        shareUrl: event.actual?.shareUrl ?? null,
        pending: null,
        error: true,
      };
  }
}

/**
 * Saves who can view a page. A failure may still have been saved with only its answer lost, so
 * the server is asked what the page is now; null when it can't say either.
 */
export function savePageVisibility(
  pageId: string,
  visibility: PageVisibility,
  dispatch: (event: PageShareEvent) => void,
) {
  return setPageVisibility(pageId, visibility).then(
    (result) => dispatch({ type: "saved", visibility, shareUrl: result.shareUrl }),
    () =>
      getLatestPage(pageId, { refresh: true, link: true }).then(
        (page) => dispatch({ type: "failed", visibility, actual: page }),
        () => dispatch({ type: "failed", visibility, actual: null }),
      ),
  );
}

/** The link to copy, share or open: only once anyone with it can view the page. */
export function pageShareLink(state: PageShareState): string | null {
  return state.pending === null && state.visibility === "link" ? state.shareUrl : null;
}

const pageReads = new Map<string, { read: Promise<PageDetail>; at: number }>();
// Another account or server never sees this one's pages.
registerSessionDiskCache(() => pageReads.clear());

// Module-level beside the read cache it governs: cards in any thread and the page screen share it.
let lastOnScreen = 0;
const onScreenListeners = new Set<() => void>();

/** When a chat last came back on screen; a page read before then is read again once. */
export const chatOnScreen = {
  get: () => lastOnScreen,
  subscribe(listener: () => void) {
    onScreenListeners.add(listener);
    return () => onScreenListeners.delete(listener);
  },
  mark() {
    lastOnScreen = Date.now();
    for (const listener of onScreenListeners) listener();
  },
};

/** The latest version: one read per page until a newer version is known or the chat refocuses. */
export function getLatestPage(
  pageId: string,
  options: { refresh?: boolean; atLeastVersion?: number; since?: number; link?: boolean } = {},
): Promise<PageDetail> {
  const cached = options.refresh ? undefined : pageReads.get(pageId);
  if (cached && cached.at >= (options.since ?? lastOnScreen)) {
    const wanted = options.atLeastVersion ?? 0;
    return cached.read.then((page) =>
      page.currentVersion >= wanted ? page : getLatestPage(pageId, { refresh: true }),
    );
  }
  const read = rpc("pages/get", options.link ? { pageId, link: true } : { pageId });
  const entry = { read, at: Date.now() };
  pageReads.set(pageId, entry);
  read.catch(() => {
    if (pageReads.get(pageId) === entry) pageReads.delete(pageId);
  });
  return read;
}

// A failed change may still have been made, so the cached read is dropped either way.
export function setPageVisibility(pageId: string, visibility: PageVisibility) {
  return rpc("pages/setVisibility", { pageId, visibility }).finally(() => pageReads.delete(pageId));
}

export function renamePage(pageId: string, title: string) {
  return rpc("pages/rename", { pageId, title }).finally(() => pageReads.delete(pageId));
}

export function removePage(pageId: string) {
  return rpc("pages/remove", { pageId })
    .catch((error: unknown) => {
      // NOT_FOUND: another device deleted it first, which is the outcome asked for.
      if (pageReadFailure(error) === "deleted") return { ok: true as const };
      throw error;
    })
    .finally(() => pageReads.delete(pageId));
}

export async function pageDocument(
  apiBase: string,
  code: string,
  theme: "light" | "dark",
  errorTitle: string,
  options: { reply?: boolean } = {},
): Promise<string> {
  const runtime = await loadPageRuntime(apiBase);
  return pageViewerDocument({
    runtime,
    code,
    theme,
    errorTitle,
    touch: true,
    lang: getActiveUiLocale(),
    ...options,
  });
}
