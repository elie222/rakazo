// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import type { PageComment, PageReview, PageSectionAnchor } from "@rakazo/contracts";
import { PAGE_REVISION_NOT_FOUND } from "@rakazo/contracts";
import { deferred, flush } from "@rakazo/core/test-async";
import type { Query } from "@tanstack/react-query";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpaceRpcProvider } from "../../lib/query/space-rpc";
import PageReviewHost from "./PageReviewHost";

const rpcState = vi.hoisted(() => ({
  spaceId: "space-1",
  getReview: vi.fn<(input: { pageId: string; version?: number }) => Promise<PageReview>>(),
  getReviewBySpace: undefined as
    | ((input: { pageId: string; version?: number }, spaceId?: string) => Promise<PageReview>)
    | undefined,
  getComments:
    vi.fn<
      (input: {
        pageId: string;
        cursor?: string;
      }) => Promise<{ items: PageComment[]; nextCursor: string | null }>
    >(),
  getDraft:
    vi.fn<
      (input: { pageId: string; requestId: string }) => Promise<{
        code: string;
        images: Record<string, never>;
        version: number;
      }>
    >(),
  addComment: vi.fn<(input: Record<string, unknown>) => Promise<void>>(),
  publish: vi.fn<(input: { pageId: string; requestId: string }) => Promise<void>>(),
  saveState: vi.fn<(input: Record<string, unknown>) => Promise<void>>(),
  list: vi.fn<
    () => Promise<{ items: { id: string; title: string }[]; nextCursor: string | null }>
  >(),
}));

const viewState = vi.hoisted(() => ({
  reportSections: undefined as ((sections: PageSectionAnchor[]) => void) | undefined,
  saveReaderState: undefined as ((values: Record<string, string>) => void) | undefined,
  navigateTo: undefined as ((to: string) => void) | undefined,
}));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ i18n: { locale: "en" }, t: String.raw }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("../../lib/query/rpc", () => {
  const makeClient = (boundSpaceId?: string) => ({
    notifications: {
      subscribe: async () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => deferred<IteratorResult<never>>().promise,
        }),
      }),
    },
    pageReviews: {
      get: (input: { pageId: string; version?: number }) =>
        rpcState.getReviewBySpace
          ? rpcState.getReviewBySpace(input, boundSpaceId)
          : rpcState.getReview(input),
      comments: (input: { pageId: string; cursor?: string }) => rpcState.getComments(input),
      draft: (input: { pageId: string; requestId: string }) => rpcState.getDraft(input),
      comment: (input: Record<string, unknown>) => rpcState.addComment(input),
      publish: (input: { pageId: string; requestId: string }) => rpcState.publish(input),
      resolve: vi.fn(),
      askRevision: vi.fn(),
      list: () => rpcState.list(),
      image: vi.fn(),
      saveState: (input: Record<string, unknown>) => rpcState.saveState(input),
    },
    pages: {
      get: vi.fn(),
    },
  });
  const defaultClient = makeClient();
  return {
    rpc: defaultClient,
    selectedSpaceId: () => rpcState.spaceId,
    rpcForSpace: (spaceId: string) => makeClient(spaceId),
    createSpaceRpc: (spaceId: string | null) => makeClient(spaceId ?? undefined),
  };
});

vi.mock("./PageView", () => ({
  PageView: ({
    title,
    document: pageDocument,
    share,
    notice,
    titleError,
    onSaveState,
    onSections,
  }: {
    title: string;
    document?: string;
    share: ReactNode;
    notice?: ReactNode;
    titleError?: string | null;
    onSaveState?: (values: Record<string, string>) => void;
    onSections?: (sections: PageSectionAnchor[]) => void;
  }) => {
    viewState.reportSections = onSections;
    viewState.saveReaderState = onSaveState;
    return (
      <div data-testid="page-review-view">
        <h1>{title}</h1>
        {pageDocument ? <div data-testid="review-document" /> : null}
        {titleError ? (
          <p role="alert" data-testid="review-inline-error">
            {titleError}
          </p>
        ) : null}
        {share}
        {notice}
      </div>
    );
  },
}));

function makePage(overrides: Partial<PageReview> = {}): PageReview {
  return {
    id: "page-1",
    title: "Launch Plan",
    code: "<main><h1>Summary</h1><h2>Pricing</h2></main>",
    images: {},
    version: 1,
    currentVersion: 1,
    owner: true,
    canRequestRevision: true,
    ...overrides,
  } as PageReview;
}

function makeComment(overrides: Partial<PageComment> = {}): PageComment {
  return {
    id: "comment-1",
    pageId: "page-1",
    version: 1,
    section: "Summary",
    sectionOccurrence: 0,
    body: "Existing note",
    author: "Alex",
    mine: true,
    createdAt: "2026-11-26T10:00:00.000Z",
    resolvedAt: null,
    revision: null,
    ...overrides,
  } as PageComment;
}

function NavigatorCapture() {
  const navigate = useNavigate();
  viewState.navigateTo = (to: string) => void navigate(to);
  return null;
}

function setFieldValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

let root: Root;
let queryClient: QueryClient;

async function mountReview(initialEntry = "/review/page-1", staleTime = 0) {
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime },
    },
  });
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialEntry]}>
          <NavigatorCapture />
          <Routes>
            <Route path="/review/:pageId" element={<PageReviewHost />} />
            <Route path="/review" element={<PageReviewHost />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await act(flush);
}

async function clickButton(predicate: (button: HTMLButtonElement) => boolean) {
  const button = [...document.querySelectorAll("button")].find(predicate);
  expect(button).toBeDefined();
  await act(async () => {
    button!.click();
  });
  await act(flush);
}

async function openCommentsPopover() {
  await clickButton((button) => button.getAttribute("aria-label") === "Comments");
}

function commentTextarea() {
  return document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment"]');
}

function sectionInput() {
  return document.querySelector<HTMLInputElement>('input[aria-label="Section"]');
}

/** Cached `pageReviews.get` reads of page-1, keyed by the revision each asked for. */
function cachedPageReads(): Map<number | undefined, Query> {
  const reads = new Map<number | undefined, Query>();
  for (const query of queryClient.getQueryCache().getAll()) {
    const path = query.queryKey[0];
    const input = (
      query.queryKey[1] as { input?: { pageId?: string; version?: number } } | undefined
    )?.input;
    if (
      Array.isArray(path) &&
      path[2] === "pageReviews" &&
      path[3] === "get" &&
      input?.pageId === "page-1"
    ) {
      reads.set(input.version, query);
    }
  }
  return reads;
}

/** The query that lists the comments of page-1. */
function commentsQuery(): Query | undefined {
  return queryClient.getQueryCache().findAll({
    predicate: (query) => {
      const path = query.queryKey[0];
      const input = (query.queryKey[1] as { input?: { pageId?: string } } | undefined)?.input;
      return (
        Array.isArray(path) &&
        path[2] === "pageReviews" &&
        path[3] === "comments" &&
        input?.pageId === "page-1"
      );
    },
  })[0];
}

/** The comments of page-1 still cached for the reviewer. */
function cachedComments() {
  return [commentsQuery()].filter((query) => query?.state.data !== undefined);
}

/** Refreshes the page's latest read and waits until the server answered it. */
async function refreshLatestRead() {
  const latestRead = cachedPageReads().get(undefined);
  await act(async () => {
    await queryClient.refetchQueries({ predicate: (query) => query === latestRead });
  });
}

/** The query that lists the pages shared with the reviewer. */
function listQuery(): Query | undefined {
  return queryClient.getQueryCache().findAll({
    predicate: (query) => {
      const path = query.queryKey[0];
      return Array.isArray(path) && path[2] === "pageReviews" && path[3] === "list";
    },
  })[0];
}

/** The pages the cached list of shared pages names, each with its title. */
function listedPages(): Array<[string, string]> {
  const list = listQuery()?.state.data as
    | { pages: Array<{ items: Array<{ id: string; title: string }> }> }
    | undefined;
  return (list?.pages ?? []).flatMap((page) => page.items.map((item) => [item.id, item.title]));
}

function refusedPage() {
  return Object.assign(new Error("Page not found"), { code: "NOT_FOUND", status: 404 });
}

/** Sets when a cached read of page-1 was last updated, which is what two reads of one revision compare. */
function pinReadTime(version: number | undefined, updatedAt: number) {
  act(() => {
    cachedPageReads().get(version)?.setState({ dataUpdatedAt: updatedAt });
  });
}

/** The server's answer for a revision below the lowest one the reviewer may read. */
function revisionRefusal(readableFrom?: unknown) {
  return Object.assign(new Error("Not found"), {
    code: PAGE_REVISION_NOT_FOUND,
    status: 404,
    data: readableFrom === undefined ? undefined : { readableFrom },
  });
}

/** Reads of a page whose latest revision is `current`, which the reviewer may read from `floor`. */
function grantedPage(grant: { floor: number; current: number }) {
  return async ({ version }: { pageId: string; version?: number }) => {
    if (version !== undefined && version < grant.floor) throw revisionRefusal(grant.floor);
    return makePage({ version: version ?? grant.current, currentVersion: grant.current });
  };
}

/** Opens a revision from its comment and waits until the server answered that read. */
async function openRevision(version: number) {
  await openCommentsPopover();
  await clickButton((button) => button.textContent?.includes(`Revision ${version}`) ?? false);
  await vi.waitFor(() => {
    expect(rpcState.getReview).toHaveBeenCalledWith({ pageId: "page-1", version });
  });
}

/** Leaves the page and comes back, so every read is requested again. */
async function reopenReview() {
  await act(async () => {
    viewState.navigateTo?.("/review");
  });
  await act(flush);
  await act(async () => {
    viewState.navigateTo?.("/review/page-1");
  });
  await act(flush);
}

beforeEach(() => {
  i18n.load("en", {});
  i18n.activate("en");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal("fetch", async () => new Response(""));
  viewState.reportSections = undefined;
  viewState.saveReaderState = undefined;
  viewState.navigateTo = undefined;
  rpcState.spaceId = "space-1";
  rpcState.getReviewBySpace = undefined;
  rpcState.getReview.mockReset();
  rpcState.getComments.mockReset();
  rpcState.getDraft.mockReset();
  rpcState.addComment.mockReset();
  rpcState.publish.mockReset();
  rpcState.saveState.mockReset();
  rpcState.list.mockReset();
  rpcState.getReview.mockResolvedValue(makePage());
  rpcState.getComments.mockResolvedValue({ items: [], nextCursor: null });
  rpcState.getDraft.mockResolvedValue({ code: "<main>draft</main>", images: {}, version: 1 });
  rpcState.addComment.mockResolvedValue(undefined);
  rpcState.publish.mockResolvedValue(undefined);
  rpcState.saveState.mockResolvedValue(undefined);
  rpcState.list.mockResolvedValue({ items: [], nextCursor: null });
});

afterEach(async () => {
  if (root) {
    await act(async () => root.unmount());
  }
  queryClient?.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("PageReviewHost comment draft preservation", () => {
  it("preserves typed section and body across popover close/reopen, revision switch, and draft preview", async () => {
    const olderPage = makePage({ version: 1, currentVersion: 2 });
    const latestPage = makePage({ version: 2, currentVersion: 2 });
    rpcState.getReview.mockImplementation(async ({ version }) =>
      version === 1 ? olderPage : latestPage,
    );
    rpcState.getComments.mockResolvedValue({
      items: [
        makeComment({
          id: "c-old",
          version: 1,
          section: "Summary",
          body: "Check intro",
        }),
        makeComment({
          id: "c-ready",
          version: 2,
          section: "Pricing",
          body: "Update table",
          revision: { id: "draft-1", status: "ready" } as PageComment["revision"],
        }),
      ],
      nextCursor: null,
    });

    await mountReview("/review/page-1");
    await openCommentsPopover();

    await act(async () => {
      setFieldValue(sectionInput()!, "Pricing");
      setFieldValue(commentTextarea()!, "Keep this draft comment");
    });

    // Close with Escape and reopen the popover.
    await act(async () => {
      commentTextarea()!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await act(flush);
    expect(commentTextarea()).toBeNull();
    await openCommentsPopover();
    expect(sectionInput()?.value).toBe("Pricing");
    expect(commentTextarea()?.value).toBe("Keep this draft comment");

    // Picked section from OptionSelect also survives popover close and reopen.
    await act(async () => {
      viewState.reportSections?.([{ section: "Summary" }, { section: "Pricing" }]);
    });
    await clickButton((button) => button.getAttribute("aria-label") === "Section");
    const summaryOption = [...document.querySelectorAll('[role="option"]')].find(
      (option) => option.textContent === "Summary",
    ) as HTMLElement | undefined;
    expect(summaryOption).toBeDefined();
    await act(async () => {
      summaryOption!.click();
    });
    await openCommentsPopover();
    expect(commentTextarea()).toBeNull();
    await openCommentsPopover();
    expect(document.querySelector('button[aria-label="Section"]')?.textContent).toContain(
      "Summary",
    );
    expect(commentTextarea()?.value).toBe("Keep this draft comment");
    await act(async () => {
      viewState.reportSections?.([]);
    });

    // Switch to an older revision, then return to latest.
    await clickButton((button) => button.textContent?.includes("Revision 1") ?? false);
    expect(commentTextarea()).toBeNull();
    await clickButton((button) => button.textContent?.includes("Back to latest") ?? false);
    await openCommentsPopover();
    expect(sectionInput()?.value).toBe("Pricing");
    expect(commentTextarea()?.value).toBe("Keep this draft comment");

    // Preview a ready draft (unmounts ReviewControls), then return to comments.
    const readyComment = [...document.querySelectorAll("li")].find((item) =>
      item.textContent?.includes("Update table"),
    );
    expect(readyComment).toBeDefined();
    const actionsButton = readyComment!.querySelector<HTMLButtonElement>(
      'button[aria-label="Comment actions"]',
    );
    expect(actionsButton).not.toBeNull();
    await act(async () => {
      actionsButton!.click();
    });
    await act(flush);
    const previewItem = [...document.querySelectorAll('[role="menuitem"]')].find((item) =>
      item.textContent?.includes("Preview draft"),
    ) as HTMLElement | undefined;
    expect(previewItem).toBeDefined();
    await act(async () => {
      previewItem!.click();
    });
    await act(flush);
    expect(commentTextarea()).toBeNull();

    await clickButton((button) => button.textContent?.includes("Back to comments") ?? false);
    expect(sectionInput()?.value).toBe("Pricing");
    expect(commentTextarea()?.value).toBe("Keep this draft comment");
  });

  it("keeps typed body when publishing a new revision and clears section even when the same section still exists", async () => {
    let current = makePage({ version: 1, currentVersion: 1 });
    rpcState.getReview.mockImplementation(async () => current);
    rpcState.getComments.mockResolvedValue({
      items: [
        makeComment({
          id: "comment-draft",
          version: 1,
          revision: {
            id: "rev-1",
            status: "ready",
            resultVersion: null,
            error: null,
          } as PageComment["revision"],
        }),
      ],
      nextCursor: null,
    });
    rpcState.getDraft.mockResolvedValue({
      code: "<main><h1>Summary</h1><h2>Pricing</h2><h2>FAQ</h2></main>",
      images: {},
      version: 2,
    });
    rpcState.publish.mockImplementation(async () => {
      current = makePage({
        version: 2,
        currentVersion: 2,
        code: "<main><h1>Summary</h1><h2>Pricing</h2><h2>FAQ</h2></main>",
      });
    });

    await mountReview("/review/page-1");
    await act(async () => {
      viewState.reportSections?.([{ section: "Summary" }, { section: "Pricing" }]);
    });
    await openCommentsPopover();

    // Pick a section via the section select and type a comment body.
    await clickButton((button) => button.getAttribute("aria-label") === "Section");
    const pricingOption = [...document.querySelectorAll('[role="option"]')].find(
      (option) => option.textContent === "Pricing",
    ) as HTMLElement | undefined;
    expect(pricingOption).toBeDefined();
    await act(async () => {
      pricingOption!.click();
    });
    await act(async () => {
      setFieldValue(commentTextarea()!, "Still typing while owner publishes");
    });
    expect(document.querySelector('button[aria-label="Section"]')?.textContent).toContain(
      "Pricing",
    );

    // Open the draft preview and publish the new revision, keeping "Pricing" available in v2.
    await clickButton((button) => button.getAttribute("aria-label") === "Comment actions");
    await act(flush);
    const previewItem = [...document.querySelectorAll('[role="menuitem"]')].find((item) =>
      item.textContent?.includes("Preview draft"),
    ) as HTMLElement | undefined;
    expect(previewItem).toBeDefined();
    await act(async () => {
      previewItem!.click();
    });
    await act(flush);
    await clickButton((button) => button.textContent?.includes("Publish revision") ?? false);
    await vi.waitFor(() => {
      expect(rpcState.publish).toHaveBeenCalledTimes(1);
      expect(commentTextarea()).not.toBeNull();
    });
    await act(async () => {
      viewState.reportSections?.([
        { section: "Summary" },
        { section: "Pricing" },
        { section: "FAQ" },
      ]);
    });
    await act(flush);

    expect(commentTextarea()?.value).toBe("Still typing while owner publishes");
    expect(document.querySelector('button[aria-label="Section"]')?.textContent).toContain(
      "Choose a section",
    );
  });

  it("does not clear the selected section when revisiting a cached older revision with stale currentVersion", async () => {
    let latestVersion = 2;
    const rev1Fetch = deferred<PageReview>();
    let rev1Calls = 0;
    rpcState.getReview.mockImplementation(async ({ version }) => {
      if (version === 1) {
        rev1Calls += 1;
        if (rev1Calls === 1) return makePage({ version: 1, currentVersion: 2 });
        return rev1Fetch.promise;
      }
      return makePage({ version: latestVersion, currentVersion: latestVersion });
    });
    rpcState.getComments.mockResolvedValue({
      items: [makeComment({ id: "comment-v1", version: 1, section: "Summary" })],
      nextCursor: null,
    });

    await mountReview("/review/page-1");
    await openCommentsPopover();

    // Visit revision 1 while version 2 is current so revision 1 is cached with currentVersion: 2.
    await clickButton((button) => button.textContent?.includes("Revision 1") ?? false);
    await clickButton((button) => button.textContent?.includes("Back to latest") ?? false);

    // Advance latest to version 3, pick Pricing, and type a draft.
    latestVersion = 3;
    await act(async () => {
      await queryClient.refetchQueries({ type: "active" });
    });
    await act(flush);
    await act(async () => {
      viewState.reportSections?.([{ section: "Summary" }, { section: "Pricing" }]);
    });
    await openCommentsPopover();
    await clickButton((button) => button.getAttribute("aria-label") === "Section");
    const pricingOption = [...document.querySelectorAll('[role="option"]')].find(
      (option) => option.textContent === "Pricing",
    ) as HTMLElement | undefined;
    expect(pricingOption).toBeDefined();
    await act(async () => {
      pricingOption!.click();
    });
    await act(async () => {
      setFieldValue(commentTextarea()!, "Draft targeting v3");
    });

    // Revisit revision 1: cached metadata has stale currentVersion: 2 while refetch is still pending.
    await clickButton((button) => button.textContent?.includes("Revision 1") ?? false);
    await clickButton((button) => button.textContent?.includes("Back to latest") ?? false);
    await act(async () => {
      viewState.reportSections?.([{ section: "Summary" }, { section: "Pricing" }]);
    });
    await openCommentsPopover();

    expect(commentTextarea()?.value).toBe("Draft targeting v3");
    expect(document.querySelector('button[aria-label="Section"]')?.textContent).toContain(
      "Pricing",
    );
    rev1Fetch.resolve(makePage({ version: 1, currentVersion: 3 }));
    await act(flush);
  });

  it("keeps the loaded page and draft visible with an inline error on transient refetch failure", async () => {
    let fail = false;
    rpcState.getReview.mockImplementation(async () => {
      if (fail) throw new Error("Failed to fetch");
      return makePage({ version: 1, currentVersion: 1 });
    });

    await mountReview("/review/page-1");
    await openCommentsPopover();
    await act(async () => {
      setFieldValue(sectionInput()!, "Summary");
      setFieldValue(commentTextarea()!, "Draft before offline refetch");
    });

    fail = true;
    await act(async () => {
      await queryClient.refetchQueries();
    });
    await act(flush);

    expect(document.body.textContent).not.toContain("This page isn't available");
    expect(document.querySelector('[data-testid="review-document"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="review-inline-error"]')?.textContent).toBeTruthy();
    expect(sectionInput()?.value).toBe("Summary");
    expect(commentTextarea()?.value).toBe("Draft before offline refetch");
  });

  it("prioritizes the unsaved-changes warning over a transient refresh error", async () => {
    let failRefresh = false;
    rpcState.getReview.mockImplementation(async () => {
      if (failRefresh) throw new Error("Failed to fetch");
      return makePage({
        version: 1,
        currentVersion: 1,
        readerState: { fields: {}, values: {} } as PageReview["readerState"],
      });
    });
    rpcState.saveState.mockRejectedValue(new Error("Failed to fetch"));

    await mountReview("/review/page-1");
    failRefresh = true;
    await act(async () => {
      await queryClient.refetchQueries();
    });
    await act(flush);
    expect(document.querySelector('[data-testid="review-inline-error"]')?.textContent).toBeTruthy();

    await act(async () => {
      viewState.saveReaderState?.({ answer: "yes" });
    });
    await act(flush);
    expect(document.querySelector('[data-testid="review-inline-error"]')?.textContent).toContain(
      "Your changes aren't saved.",
    );
  });

  it("keeps Back to latest and submits against the newest known version when revisiting a cached older revision offline", async () => {
    let phase: "v1" | "v2" | "offline" = "v1";
    rpcState.getReview.mockImplementation(async ({ version }) => {
      if (phase === "offline") throw new Error("Failed to fetch");
      if (version === 1 || phase === "v1") {
        return makePage({ version: 1, currentVersion: phase === "v1" ? 1 : 2 });
      }
      return makePage({ version: 2, currentVersion: 2 });
    });
    rpcState.getComments.mockResolvedValue({
      items: [makeComment({ id: "c-v1", version: 1, section: "Summary" })],
      nextCursor: null,
    });

    // Seed cache for revision 1 while currentVersion is 1, then advance latest to revision 2.
    await mountReview("/review/page-1");
    await openCommentsPopover();
    await clickButton((button) => button.textContent?.includes("Revision 1") ?? false);
    // Re-query latest after owner publishes revision 2.
    phase = "v2";
    await act(async () => {
      viewState.navigateTo?.("/review");
    });
    await act(flush);
    await act(async () => {
      viewState.navigateTo?.("/review/page-1");
    });
    await act(flush);
    await openCommentsPopover();

    // Go offline and revisit revision 1, which hits cached { version: 1, currentVersion: 1 }.
    phase = "offline";
    await clickButton((button) => button.textContent?.includes("Revision 1") ?? false);

    // Back to latest must still appear, and the composer must stay hidden while viewing rev 1
    // (instead of offering a composer that submits against stale version 1).
    const backButton = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Back to latest"),
    );
    expect(backButton).toBeDefined();
    await openCommentsPopover();
    expect(commentTextarea()).toBeNull();

    // Returning to latest restores the composer targeting version 2.
    await clickButton((button) => button.textContent?.includes("Back to latest") ?? false);
    if (!commentTextarea()) await openCommentsPopover();
    await act(async () => {
      setFieldValue(sectionInput()!, "Summary");
      setFieldValue(commentTextarea()!, "Comment on latest rev 2");
    });
    await clickButton((button) => button.textContent?.includes("Post comment") ?? false);
    expect(rpcState.addComment).toHaveBeenCalledWith(
      expect.objectContaining({ pageId: "page-1", version: 2 }),
    );
  });

  it("refetches an outdated latest cache inside the 30s staleTime window when clicking Back to latest and retries if offline", async () => {
    let phase: "v1" | "v2-offline-latest" | "v2" = "v1";
    rpcState.getReview.mockImplementation(async ({ version }) => {
      if (version === 1) return makePage({ version: 1, currentVersion: 2 });
      if (phase === "v1") return makePage({ version: 1, currentVersion: 1 });
      if (phase === "v2-offline-latest") throw new Error("Failed to fetch");
      return makePage({ version: 2, currentVersion: 2, title: "Launch Plan v2" });
    });
    rpcState.getComments.mockResolvedValue({
      items: [makeComment({ id: "c-v1", version: 1, section: "Summary" })],
      nextCursor: null,
    });

    // Mount with the production 30s staleTime so latest caches v1 as fresh.
    await mountReview("/review/page-1", 30_000);
    await openCommentsPopover();

    // Open historical revision 1, which reports currentVersion: 2 while latest cache still holds v1.
    phase = "v2-offline-latest";
    await clickButton((button) => button.textContent?.includes("Revision 1") ?? false);

    // Clicking Back to latest while offline attempts a refetch and keeps Back to latest visible.
    await clickButton((button) => button.textContent?.includes("Back to latest") ?? false);
    expect(document.querySelector("h1")?.textContent).toBe("Launch Plan");
    expect(
      [...document.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Back to latest"),
      ),
    ).toBeDefined();

    // Clicking Back to latest again once back online retries and loads v2.
    phase = "v2";
    await clickButton((button) => button.textContent?.includes("Back to latest") ?? false);
    expect(document.querySelector("h1")?.textContent).toBe("Launch Plan v2");
    expect(
      [...document.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Back to latest"),
      ),
    ).toBeUndefined();
  });

  it("unmounts the page on 404 or 403 and keeps it hidden across a failed retry until authorized again", async () => {
    let outcome: "ok" | "not_found" | "forbidden" | "offline" = "ok";
    rpcState.getReview.mockImplementation(async () => {
      if (outcome === "not_found")
        throw Object.assign(new Error("Page not found"), { code: "NOT_FOUND", status: 404 });
      if (outcome === "forbidden")
        throw Object.assign(new Error("Access denied"), { code: "FORBIDDEN", status: 403 });
      if (outcome === "offline") throw new Error("Failed to fetch");
      return makePage({ version: 1, currentVersion: 1 });
    });

    await mountReview("/review/page-1");
    await openCommentsPopover();
    expect(document.querySelector('[data-testid="review-document"]')).not.toBeNull();

    // Access is revoked (404): document and composer unmount immediately.
    outcome = "not_found";
    await act(async () => {
      await queryClient.refetchQueries();
    });
    await act(flush);

    expect(document.body.textContent).toContain("This page isn't available");
    expect(document.querySelector('[data-testid="review-document"]')).toBeNull();
    expect(commentTextarea()).toBeNull();

    // Clicking Try again while offline must NOT resurrect the stale cached page.
    outcome = "offline";
    await clickButton((button) => button.textContent?.includes("Try again") ?? false);
    await act(flush);

    expect(document.body.textContent).toContain("This page isn't available");
    expect(document.querySelector('[data-testid="review-document"]')).toBeNull();
    expect(commentTextarea()).toBeNull();

    // Closing and reopening the page while still offline must also keep the revoked page hidden.
    await act(async () => {
      viewState.navigateTo?.("/review");
    });
    await act(flush);
    await act(async () => {
      viewState.navigateTo?.("/review/page-1");
    });
    await act(flush);

    expect(document.body.textContent).toContain("This page isn't available");
    expect(document.querySelector('[data-testid="review-document"]')).toBeNull();
    expect(commentTextarea()).toBeNull();

    // Once authorized again, Try again restores the page.
    outcome = "ok";
    await clickButton((button) => button.textContent?.includes("Try again") ?? false);
    await act(flush);
    expect(document.querySelector('[data-testid="review-document"]')).not.toBeNull();

    // A 403 FORBIDDEN refetch also hides the page.
    outcome = "forbidden";
    await act(async () => {
      await queryClient.refetchQueries();
    });
    await act(flush);

    expect(document.body.textContent).toContain("This page isn't available");
    expect(document.querySelector('[data-testid="review-document"]')).toBeNull();
  });

  it("clears cached payloads for a revoked page across Spaces without clearing other pages", async () => {
    let outcome: "ok" | "not_found" | "offline" = "ok";
    rpcState.getReview.mockImplementation(async ({ pageId }) => {
      if (pageId === "page-1") {
        if (outcome === "not_found")
          throw Object.assign(new Error("Page not found"), { code: "NOT_FOUND", status: 404 });
        if (outcome === "offline") throw new Error("Failed to fetch");
      }
      return makePage({ id: pageId, title: pageId === "page-1" ? "Shared Page" : "Other Page" });
    });

    // Load page-1 and page-2 in space-1 so both are cached under space:space-1.
    rpcState.spaceId = "space-1";
    await mountReview("/review/page-1");
    expect(document.querySelector('[data-testid="review-document"]')).not.toBeNull();
    await act(async () => {
      viewState.navigateTo?.("/review/page-2");
    });
    await act(flush);
    expect(document.querySelector('[data-testid="review-document"]')).not.toBeNull();

    // Switch to space-2 and hit 404 for page-1.
    await act(async () => {
      viewState.navigateTo?.("/review");
    });
    await act(flush);
    rpcState.spaceId = "space-2";
    outcome = "not_found";
    await act(async () => {
      viewState.navigateTo?.("/review/page-1");
    });
    await act(flush);
    expect(document.body.textContent).toContain("This page isn't available");
    expect(document.querySelector('[data-testid="review-document"]')).toBeNull();

    // Switch back to space-1 while offline: page-1 must remain hidden, not render space-1's stale cache.
    await act(async () => {
      viewState.navigateTo?.("/review");
    });
    await act(flush);
    rpcState.spaceId = "space-1";
    outcome = "offline";
    await act(async () => {
      viewState.navigateTo?.("/review/page-1");
    });
    await act(flush);
    expect(document.body.textContent).toContain("This page isn't available");
    expect(document.querySelector('[data-testid="review-document"]')).toBeNull();

    // Another page cached in space-1 is untouched.
    const page2Cached = queryClient
      .getQueryCache()
      .findAll({
        predicate: (query) => {
          const opts = query.queryKey[1] as { input?: { pageId?: string } } | undefined;
          return opts?.input?.pageId === "page-2";
        },
      })
      .some((query) => query.state.data !== undefined);
    expect(page2Cached).toBe(true);
  });

  it("still shows the full-screen notice when the initial page load fails", async () => {
    rpcState.getReview.mockRejectedValue(new Error("Failed to fetch"));
    await mountReview("/review/page-1");
    expect(document.body.textContent).toContain("This page isn't available");
    expect(document.querySelector('[data-testid="review-inline-error"]')).toBeNull();
  });

  it("clears the draft even when the comments popover closes while a post is in flight", async () => {
    const posting = deferred<void>();
    rpcState.addComment.mockImplementation(() => posting.promise);

    await mountReview("/review/page-1");
    await openCommentsPopover();
    await act(async () => {
      setFieldValue(sectionInput()!, "Summary");
      setFieldValue(commentTextarea()!, "Sent before closing popover");
    });

    await clickButton((button) => button.textContent?.includes("Post comment") ?? false);
    expect(rpcState.addComment).toHaveBeenCalledTimes(1);

    // Close popover before the request resolves.
    await clickButton((button) => button.getAttribute("aria-label") === "Comments");
    expect(commentTextarea()).toBeNull();

    posting.resolve(undefined);
    await act(flush);

    await openCommentsPopover();
    expect(sectionInput()?.value).toBe("");
    expect(commentTextarea()?.value).toBe("");
  });

  it("clears the draft after a successful post and resets it when switching pages", async () => {
    rpcState.getReview.mockImplementation(async ({ pageId }) =>
      makePage({ id: pageId, title: pageId === "page-1" ? "Page One" : "Page Two" }),
    );

    await mountReview("/review/page-1");
    await openCommentsPopover();
    await act(async () => {
      setFieldValue(sectionInput()!, "Summary");
      setFieldValue(commentTextarea()!, "Ship it");
    });

    await clickButton((button) => button.textContent?.includes("Post comment") ?? false);
    await vi.waitFor(() => {
      expect(rpcState.addComment).toHaveBeenCalledTimes(1);
      expect(commentTextarea()?.value).toBe("");
    });
    expect(sectionInput()?.value).toBe("");

    // Type a new draft on page-1, then switch to page-2 and confirm the draft resets.
    await act(async () => {
      setFieldValue(sectionInput()!, "Pricing");
      setFieldValue(commentTextarea()!, "Draft for page one");
    });
    await act(async () => {
      viewState.navigateTo?.("/review/page-2");
    });
    await act(flush);
    await openCommentsPopover();
    expect(sectionInput()?.value).toBe("");
    expect(commentTextarea()?.value).toBe("");
  });

  it("blocks saving reader state from a cached historical revision whose refresh fails after a newer version is known", async () => {
    let failV1 = false;
    rpcState.getReview.mockImplementation(async ({ version }) => {
      if (version === 1) {
        if (failV1) throw new Error("Failed to fetch");
        return makePage({
          version: 1,
          currentVersion: 1,
          readerState: { fields: {}, values: { note: "from-v1" } } as PageReview["readerState"],
        });
      }
      return makePage({
        version: 2,
        currentVersion: 2,
        readerState: { fields: {}, values: { note: "from-v2" } } as PageReview["readerState"],
      });
    });
    rpcState.getComments.mockResolvedValue({
      items: [makeComment({ id: "comment-v1", version: 1, section: "Summary", body: "v1 note" })],
      nextCursor: null,
    });

    await mountReview("/review/page-1");
    expect(viewState.saveReaderState).toBeTypeOf("function");

    // Populate the cached version=1 query with a stale snapshot carrying currentVersion=1 and readerState.
    await openCommentsPopover();
    await clickButton((button) => button.textContent?.includes("Revision 1") ?? false);
    await vi.waitFor(() => {
      expect(rpcState.getReview).toHaveBeenCalledWith({ pageId: "page-1", version: 1 });
    });
    expect(viewState.saveReaderState).toBeUndefined();

    // Return to latest v2 and confirm reader state saving is enabled again.
    await clickButton((button) => button.textContent?.includes("Back to latest") ?? false);
    await vi.waitFor(() => {
      expect(viewState.saveReaderState).toBeTypeOf("function");
    });

    // Revisit cached v1 while its refresh fails: v2 is known, so reader state saving must stay disabled.
    failV1 = true;
    await openCommentsPopover();
    await clickButton((button) => button.textContent?.includes("Revision 1") ?? false);
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="review-inline-error"]')).not.toBeNull();
    });
    expect(viewState.saveReaderState).toBeUndefined();
    expect(rpcState.saveState).not.toHaveBeenCalled();

    // Returning to latest v2 re-enables reader state saving.
    await clickButton((button) => button.textContent?.includes("Back to latest") ?? false);
    await vi.waitFor(() => {
      expect(viewState.saveReaderState).toBeTypeOf("function");
    });
  });

  it("keeps cached v1 read-only after reopening the review offline once v2 was observed", async () => {
    let phase: "v1" | "offline" = "v1";
    rpcState.getReview.mockImplementation(async ({ version }) => {
      if (version === 1) {
        return makePage({
          version: 1,
          currentVersion: 2,
          readerState: { fields: {}, values: { note: "from-v1" } } as PageReview["readerState"],
        });
      }
      if (phase === "offline") throw new Error("Failed to fetch");
      return makePage({
        version: 1,
        currentVersion: 1,
        readerState: { fields: {}, values: { note: "from-v1" } } as PageReview["readerState"],
      });
    });
    rpcState.getComments.mockResolvedValue({
      items: [makeComment({ id: "comment-v1", version: 1, section: "Summary", body: "v1 note" })],
      nextCursor: null,
    });

    await mountReview("/review/page-1");
    expect(viewState.saveReaderState).toBeTypeOf("function");

    // Open revision 1, whose response reports currentVersion: 2 while latest cache still holds v1.
    await openCommentsPopover();
    await clickButton((button) => button.textContent?.includes("Revision 1") ?? false);
    await vi.waitFor(() => {
      expect(rpcState.getReview).toHaveBeenCalledWith({ pageId: "page-1", version: 1 });
    });

    // Close and reopen the review while offline so the mounted component resets commentDraft.version.
    phase = "offline";
    await act(async () => {
      viewState.navigateTo?.("/review");
    });
    await act(flush);
    await act(async () => {
      viewState.navigateTo?.("/review/page-1");
    });
    await act(flush);

    expect(viewState.saveReaderState).toBeUndefined();
    expect(
      [...document.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Back to latest"),
      ),
    ).toBeDefined();
    await openCommentsPopover();
    expect(commentTextarea()).toBeNull();
  });

  it("rejects in-flight pre-denial reads after revocation while allowing a later authorized retry", async () => {
    const slowHistorical = deferred<PageReview>();
    let historicalCalls = 0;
    let latestMode: "ok" | "denied" | "offline" | "restored" = "ok";
    rpcState.getReview.mockImplementation(async ({ version }) => {
      if (version === 1) {
        historicalCalls += 1;
        if (historicalCalls === 1) return makePage({ version: 1, currentVersion: 2 });
        return slowHistorical.promise;
      }
      if (latestMode === "denied") {
        throw Object.assign(new Error("Forbidden"), { code: "FORBIDDEN", status: 403 });
      }
      if (latestMode === "offline") throw new Error("Failed to fetch");
      return makePage({ version: 2, currentVersion: 2 });
    });
    rpcState.getComments.mockResolvedValue({
      items: [makeComment({ id: "comment-v1", version: 1, section: "Summary", body: "v1 note" })],
      nextCursor: null,
    });

    await mountReview("/review/page-1");
    expect(document.querySelector('[data-testid="review-document"]')).not.toBeNull();

    // Prime revision 1 once, return to latest, then reopen revision 1 so its refetch stays in flight.
    await openCommentsPopover();
    await clickButton((button) => button.textContent?.includes("Revision 1") ?? false);
    await vi.waitFor(() => {
      expect(historicalCalls).toBe(1);
    });
    await clickButton((button) => button.textContent?.includes("Back to latest") ?? false);
    await openCommentsPopover();
    await clickButton((button) => button.textContent?.includes("Revision 1") ?? false);
    await vi.waitFor(() => {
      expect(historicalCalls).toBe(2);
    });

    // Switch back to latest and receive 403 Forbidden while the revision 1 read is still pending.
    latestMode = "denied";
    await clickButton((button) => button.textContent?.includes("Back to latest") ?? false);
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("This page isn't available");
    });

    // The pre-denial revision 1 read now finishes; it must not repopulate the query cache.
    slowHistorical.resolve(makePage({ version: 1, currentVersion: 2 }));
    await act(flush);
    const cachedPayloads = queryClient
      .getQueryCache()
      .findAll({
        predicate: (query) => {
          const path = query.queryKey[0];
          const opts = query.queryKey[1] as { input?: { pageId?: string } } | undefined;
          return (
            Array.isArray(path) &&
            path[2] === "pageReviews" &&
            path[3] === "get" &&
            opts?.input?.pageId === "page-1"
          );
        },
      })
      .filter((query) => query.state.data !== undefined);
    expect(cachedPayloads).toHaveLength(0);

    // Offline refresh must keep the page hidden.
    latestMode = "offline";
    await clickButton((button) => button.textContent === "Try again");
    expect(document.body.textContent).toContain("This page isn't available");
    expect(document.querySelector('[data-testid="review-document"]')).toBeNull();

    // A newly started authorized retry after the denial restores the page.
    latestMode = "restored";
    await clickButton((button) => button.textContent === "Try again");
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="review-document"]')).not.toBeNull();
    });
  });

  it("allows an in-flight owner read in the owning Space to succeed after a 404 in another Space", async () => {
    const ownerRead = deferred<PageReview>();
    const calls: Array<string | undefined> = [];
    rpcState.getReviewBySpace = async (_input, spaceId) => {
      calls.push(spaceId);
      if (spaceId === "space-1") return ownerRead.promise;
      throw Object.assign(new Error("Page not found"), { code: "NOT_FOUND", status: 404 });
    };

    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SpaceRpcProvider spaceId="space-1">
            <MemoryRouter initialEntries={["/review/page-1"]}>
              <Routes>
                <Route path="/review/:pageId" element={<PageReviewHost />} />
              </Routes>
            </MemoryRouter>
          </SpaceRpcProvider>
        </QueryClientProvider>,
      );
    });
    await act(flush);
    expect(calls).toEqual(["space-1"]);

    // Mount a second view bound to another Space while space-1's owner read stays in flight.
    const secondRoot = createRoot(document.body.appendChild(document.createElement("div")));
    try {
      await act(async () => {
        secondRoot.render(
          <QueryClientProvider client={queryClient}>
            <SpaceRpcProvider spaceId="space-2">
              <MemoryRouter initialEntries={["/review/page-1"]}>
                <Routes>
                  <Route path="/review/:pageId" element={<PageReviewHost />} />
                </Routes>
              </MemoryRouter>
            </SpaceRpcProvider>
          </QueryClientProvider>,
        );
      });
      await act(flush);
      expect(document.body.textContent).toContain("This page isn't available");

      // Resolve space-1's owner read: it must still commit and render in space-1.
      ownerRead.resolve(makePage({ version: 1, currentVersion: 1, owner: true }));
      await act(flush);
      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="review-document"]')).not.toBeNull();
      });
      const space1Cached = queryClient
        .getQueryCache()
        .findAll({
          predicate: (query) => {
            const path = query.queryKey[0];
            const opts = query.queryKey[1] as { input?: { pageId?: string } } | undefined;
            return (
              Array.isArray(path) &&
              path[1] === "space:space-1" &&
              path[2] === "pageReviews" &&
              path[3] === "get" &&
              opts?.input?.pageId === "page-1"
            );
          },
        })
        .some((query) => query.state.data !== undefined);
      expect(space1Cached).toBe(true);
    } finally {
      await act(async () => secondRoot.unmount());
    }
  });

  it("keeps the accessible latest revision cached when an older pre-grant revision returns 404", async () => {
    const grant = { floor: 1, current: 2 };
    rpcState.getReview.mockImplementation(grantedPage(grant));
    rpcState.getComments.mockResolvedValue({
      items: [makeComment({ id: "comment-v1", version: 1, section: "Summary", body: "v1 note" })],
      nextCursor: null,
    });

    await mountReview("/review/page-1");
    expect(document.querySelector('[data-testid="review-document"]')).not.toBeNull();
    // Revision 1 is read and cached while the reviewer's grant still covers it.
    await openRevision(1);
    await clickButton((button) => button.textContent?.includes("Back to latest") ?? false);

    // The grant is replaced and now starts at revision 2, so revision 1 is refused on its own.
    grant.floor = 2;
    await openRevision(1);
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("This page isn't available");
    });

    // The refused revision loses its cached payload.
    const reads = cachedPageReads();
    expect(reads.get(1)?.state.data).toBeUndefined();
    // Latest revision (version: undefined) must keep its cached payload instead of being erased.
    expect(reads.get(undefined)?.state.data).toBeDefined();
    // Its siblings are invalidated, so the latest revalidates when it is shown again.
    expect(reads.get(undefined)?.state.isInvalidated).toBe(true);
  });

  it("drops a cached latest revision that a replacement grant leaves below its floor", async () => {
    const grant = { floor: 1, current: 2 };
    let offline = false;
    rpcState.getReview.mockImplementation(async (input) => {
      if (offline) throw new Error("Failed to fetch");
      return grantedPage(grant)(input);
    });
    rpcState.getComments.mockResolvedValue({
      items: [
        makeComment({ id: "comment-v1", version: 1, section: "Summary" }),
        makeComment({ id: "comment-v3", version: 3, section: "Pricing" }),
      ],
      nextCursor: null,
    });

    // Revision 2 is cached as the latest one, and revision 1 under its own number.
    await mountReview("/review/page-1");
    await openRevision(1);

    // The owner publishes revision 3 and replaces the grant to start there.
    grant.floor = 3;
    grant.current = 3;
    await openRevision(3);
    // Revision 1 is refused, and the server names revision 3 as the lowest readable one.
    await openRevision(1);
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("This page isn't available");
    });
    const reads = cachedPageReads();
    // The refused revision and revision 2, cached under the latest key, are gone.
    expect(reads.get(1)?.state.data).toBeUndefined();
    expect(reads.get(undefined)?.state.data).toBeUndefined();
    // Revision 3 stays cached, invalidated like every remaining read of the page.
    expect(reads.get(3)?.state.data).toMatchObject({ version: 3 });
    expect(reads.get(3)?.state.isInvalidated).toBe(true);
    // The cached comments may hold revisions below the floor, so they go too.
    expect(cachedComments()).toEqual([]);

    // Reopened offline, revision 2 does not come back.
    offline = true;
    await reopenReview();
    expect(document.body.textContent).toContain("This page isn't available");
    expect(document.querySelector('[data-testid="review-document"]')).toBeNull();
  });

  it("shows no cached comments after a refusal, while their refresh is still waiting", async () => {
    const grant = { floor: 1, current: 2 };
    const pendingComments = deferred<Awaited<ReturnType<typeof rpcState.getComments>>>();
    let refreshed = false;
    rpcState.getReview.mockImplementation(grantedPage(grant));
    rpcState.getComments.mockImplementation(async () => {
      // A refresh that never answers, as when the server is out of reach.
      if (refreshed) return pendingComments.promise;
      return {
        items: [
          makeComment({ id: "comment-v1", version: 1, section: "Summary", body: "Pre-grant note" }),
          makeComment({ id: "comment-v2", version: 2, section: "Pricing", body: "Older note" }),
        ],
        nextCursor: null,
      };
    });

    // The comments are cached while the reviewer's grant starts at revision 1.
    await mountReview("/review/page-1");
    await openCommentsPopover();
    expect(document.body.textContent).toContain("Pre-grant note");
    expect(document.body.textContent).toContain("Older note");

    // The grant is replaced to start at revision 3, and revision 1 is refused.
    grant.floor = 3;
    grant.current = 3;
    await clickButton((button) => button.textContent?.includes("Revision 1") ?? false);
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("This page isn't available");
    });
    expect(cachedComments()).toEqual([]);

    // Back at the latest revision, the popover waits for its refresh without the old comments.
    refreshed = true;
    await reopenReview();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="review-document"]')).not.toBeNull();
    });
    await openCommentsPopover();
    expect(document.body.textContent).not.toContain("Pre-grant note");
    expect(document.body.textContent).not.toContain("Older note");

    // Only what the server answers now is listed.
    pendingComments.resolve({
      items: [makeComment({ id: "comment-v3", version: 3, section: "Pricing", body: "New note" })],
      nextCursor: null,
    });
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("New note");
    });
  });

  it("does not let a refresh still in flight bring back a revision below the floor", async () => {
    const grant = { floor: 1, current: 2 };
    const slowLatest = deferred<PageReview>();
    let refetching = false;
    rpcState.getReview.mockImplementation(async (input) => {
      if (refetching && input.version === undefined) return slowLatest.promise;
      return grantedPage(grant)(input);
    });
    rpcState.getComments.mockResolvedValue({
      items: [makeComment({ id: "comment-v1", version: 1, section: "Summary" })],
      nextCursor: null,
    });

    await mountReview("/review/page-1");
    await openRevision(1);
    await clickButton((button) => button.textContent?.includes("Back to latest") ?? false);
    // A refresh of the latest revision is still waiting for the server.
    refetching = true;
    act(() => {
      void queryClient.refetchQueries();
    });
    await act(flush);

    // Meanwhile the grant is replaced to start at revision 3, and revision 1 is refused.
    grant.floor = 3;
    await openRevision(1);
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("This page isn't available");
    });

    // The refresh answers with what the page held before, which must not be cached again.
    slowLatest.resolve(makePage({ version: 2, currentVersion: 2 }));
    const latest = cachedPageReads().get(undefined);
    await vi.waitFor(() => expect(latest?.state.fetchStatus).toBe("idle"));
    expect(latest?.state.data).toBeUndefined();
  });

  it("does not let an unmounted comments refresh bring back the cleared comments", async () => {
    let outcome: "granted" | "revoked" = "granted";
    let refreshing = false;
    const pendingComments = deferred<Awaited<ReturnType<typeof rpcState.getComments>>>();
    rpcState.getReview.mockImplementation(async () => {
      if (outcome === "revoked") throw refusedPage();
      return makePage({ version: 2, currentVersion: 2 });
    });
    rpcState.getComments.mockImplementation(async () => {
      // A refresh that never answers, as when the server is out of reach.
      if (refreshing) return pendingComments.promise;
      return {
        items: [
          makeComment({ id: "comment-v1", version: 1, section: "Summary", body: "Old note" }),
        ],
        nextCursor: null,
      };
    });

    // The comments are cached while the reviewer may still read the page.
    await mountReview("/review/page-1");
    await openCommentsPopover();
    expect(document.body.textContent).toContain("Old note");
    // The popover reopens, and its refresh is still waiting for the server.
    refreshing = true;
    await act(async () => {
      commentTextarea()!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await act(flush);
    await openCommentsPopover();
    expect(commentsQuery()?.state.fetchStatus).toBe("fetching");

    // The grant ends with the popover open, so the page's own refresh is refused and unmounts it.
    outcome = "revoked";
    await refreshLatestRead();
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("This page isn't available");
    });
    expect(commentTextarea()).toBeNull();
    expect(cachedComments()).toEqual([]);
    // The stopped refresh left no error behind: the next refresh starts as any first read does.
    expect(commentsQuery()?.state).toMatchObject({
      data: undefined,
      fetchStatus: "idle",
      error: null,
    });

    // Access is granted again: the page reopens, and the popover waits for a fresh answer.
    outcome = "granted";
    await clickButton((button) => button.textContent === "Try again");
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="review-document"]')).not.toBeNull();
    });
    if (!commentTextarea()) await openCommentsPopover();
    expect(commentTextarea()).not.toBeNull();
    expect(commentsQuery()?.state.fetchStatus).toBe("fetching");
    expect(document.body.textContent).not.toContain("Old note");
  });

  it("does not list a refused page again while the shared-pages list refresh is still waiting", async () => {
    let outcome: "granted" | "revoked" = "granted";
    let refreshing = false;
    const pendingList = deferred<Awaited<ReturnType<typeof rpcState.list>>>();
    rpcState.getReview.mockImplementation(async () => {
      if (outcome === "revoked") throw refusedPage();
      return makePage({ version: 2, currentVersion: 2 });
    });
    rpcState.list.mockImplementation(async () => {
      // A refresh that never answers, as when the server is out of reach.
      if (refreshing) return pendingList.promise;
      return {
        items: [
          { id: "page-1", title: "Shared Page" },
          { id: "page-2", title: "Other Page" },
        ],
        nextCursor: null,
      };
    });

    // The list of shared pages is cached with the page's title.
    await mountReview("/review");
    expect(document.body.textContent).toContain("Shared Page");
    await act(async () => {
      viewState.navigateTo?.("/review/page-1");
    });
    await act(flush);

    // The grant ends while the page is open.
    outcome = "revoked";
    await refreshLatestRead();
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("This page isn't available");
    });

    // Back at the list, its refresh is still waiting for the server.
    refreshing = true;
    await act(async () => {
      viewState.navigateTo?.("/review");
    });
    await act(flush);
    expect(document.body.textContent).not.toContain("Shared Page");
    // The other pages the reviewer may still read stay listed.
    expect(document.body.textContent).toContain("Other Page");
    expect(rpcState.list).toHaveBeenCalledTimes(2);
  });

  it("keeps a page in the shared-pages list under a readable revision's title after a floor refusal", async () => {
    const grant = { floor: 1, current: 2 };
    let refreshing = false;
    const pendingList = deferred<Awaited<ReturnType<typeof rpcState.list>>>();
    rpcState.getReview.mockImplementation(grantedPage(grant));
    rpcState.getComments.mockResolvedValue({
      items: [
        makeComment({ id: "comment-v1", version: 1, section: "Summary" }),
        makeComment({ id: "comment-v2", version: 2, section: "Pricing" }),
      ],
      nextCursor: null,
    });
    rpcState.list.mockImplementation(async () => {
      // A refresh that never answers, as when the server is out of reach.
      if (refreshing) return pendingList.promise;
      return {
        items: [
          { id: "page-1", title: "Stale title" },
          { id: "page-2", title: "Other Page" },
        ],
        nextCursor: null,
      };
    });

    // The list names the page under its title from before, and revisions 1 and 2 are cached.
    await mountReview("/review");
    await act(async () => {
      viewState.navigateTo?.("/review/page-1");
    });
    await act(flush);
    await openRevision(1);
    await clickButton((button) => button.textContent?.includes("Back to latest") ?? false);
    await openRevision(2);

    // The grant is replaced to start at revision 2, and revision 1 is refused.
    grant.floor = 2;
    await openRevision(1);
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("This page isn't available");
    });
    const reads = cachedPageReads();
    expect(reads.get(1)?.state.data).toBeUndefined();
    expect(reads.get(2)?.state.data).toMatchObject({ version: 2 });
    // The row stays, under the title of a cached revision the server confirmed readable.
    expect(listedPages()).toEqual([
      ["page-1", "Launch Plan"],
      ["page-2", "Other Page"],
    ]);
    expect(listQuery()?.state.isInvalidated).toBe(true);

    // Back at the list, its refresh still waiting, the title from before the grant is gone.
    refreshing = true;
    await act(async () => {
      viewState.navigateTo?.("/review");
    });
    await act(flush);
    expect(document.body.textContent).toContain("Launch Plan");
    expect(document.body.textContent).not.toContain("Stale title");
  });

  it("removes a page from the shared-pages list when no revision at or above the floor is cached", async () => {
    const grant = { floor: 1, current: 2 };
    let refreshing = false;
    const pendingList = deferred<Awaited<ReturnType<typeof rpcState.list>>>();
    rpcState.getReview.mockImplementation(grantedPage(grant));
    rpcState.getComments.mockResolvedValue({
      items: [makeComment({ id: "comment-v1", version: 1, section: "Summary" })],
      nextCursor: null,
    });
    rpcState.list.mockImplementation(async () => {
      // A refresh that never answers, as when the server is out of reach.
      if (refreshing) return pendingList.promise;
      return { items: [{ id: "page-1", title: "Stale title" }], nextCursor: null };
    });

    // The list names the page, and the latest revision 2 and revision 1 are cached.
    await mountReview("/review");
    await act(async () => {
      viewState.navigateTo?.("/review/page-1");
    });
    await act(flush);
    await openRevision(1);
    await clickButton((button) => button.textContent?.includes("Back to latest") ?? false);

    // The grant is replaced to start at revision 3: nothing cached is readable any more.
    grant.floor = 3;
    grant.current = 3;
    await openRevision(1);
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("This page isn't available");
    });
    expect(listedPages()).toEqual([]);
    expect(listQuery()?.state.isInvalidated).toBe(true);

    // Back at the list, its refresh still waiting, the title from before cannot show.
    refreshing = true;
    await act(async () => {
      viewState.navigateTo?.("/review");
    });
    await act(flush);
    expect(document.body.textContent).not.toContain("Stale title");
  });

  it("takes the list row's title from the highest cached revision, not the first one cached", async () => {
    const grant = { floor: 1, current: 2 };
    rpcState.getReview.mockImplementation(async (input) => {
      const page = await grantedPage(grant)(input);
      return page.version === 3 ? { ...page, title: "Third title" } : page;
    });
    rpcState.getComments.mockResolvedValue({
      items: [
        makeComment({ id: "comment-v1", version: 1, section: "Summary" }),
        makeComment({ id: "comment-v3", version: 3, section: "Pricing" }),
      ],
      nextCursor: null,
    });
    rpcState.list.mockResolvedValue({
      items: [{ id: "page-1", title: "Stale title" }],
      nextCursor: null,
    });

    // The list names the page, and its latest read stops at revision 2.
    await mountReview("/review");
    await act(async () => {
      viewState.navigateTo?.("/review/page-1");
    });
    await act(flush);
    // The owner publishes revision 3 and starts a new grant at revision 2, which is read under its
    // own number.
    grant.floor = 2;
    grant.current = 3;
    await openRevision(3);
    // Revision 1 is refused: of the reads left cached, the first holds revision 2 and the newer
    // holds revision 3.
    await openRevision(1);
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("This page isn't available");
    });
    expect(cachedPageReads().get(undefined)?.state.data).toMatchObject({ version: 2 });
    expect(listedPages()).toEqual([["page-1", "Third title"]]);
  });

  it("takes the list row's title from the read of a revision that was updated last", async () => {
    const grant = { floor: 1, current: 2 };
    let renamed = false;
    rpcState.getReview.mockImplementation(async (input) => {
      const page = await grantedPage(grant)(input);
      return { ...page, title: renamed ? "New title" : "Old title" };
    });
    rpcState.getComments.mockResolvedValue({
      items: [
        makeComment({ id: "comment-v1", version: 1, section: "Summary" }),
        makeComment({ id: "comment-v2", version: 2, section: "Pricing" }),
      ],
      nextCursor: null,
    });
    rpcState.list.mockResolvedValue({
      items: [{ id: "page-1", title: "Stale title" }],
      nextCursor: null,
    });

    // The list names the page, and the latest read of revision 2 carries the title from before a
    // rename.
    await mountReview("/review");
    await act(async () => {
      viewState.navigateTo?.("/review/page-1");
    });
    await act(flush);
    pinReadTime(undefined, 1_000);
    // The page is renamed without a new revision. Revision 2 is then read again under its own number.
    renamed = true;
    await openRevision(2);
    pinReadTime(2, 2_000);
    // A new grant starts at revision 2, and revision 1 is refused.
    grant.floor = 2;
    await openRevision(1);
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("This page isn't available");
    });
    expect(listedPages()).toEqual([["page-1", "New title"]]);
  });

  it("takes the list row's title from the read updated last, whichever cache entry holds it", async () => {
    const grant = { floor: 1, current: 2 };
    let renamed = false;
    rpcState.getReview.mockImplementation(async (input) => {
      const page = await grantedPage(grant)(input);
      return { ...page, title: renamed ? "New title" : "Old title" };
    });
    rpcState.getComments.mockResolvedValue({
      items: [
        makeComment({ id: "comment-v1", version: 1, section: "Summary" }),
        makeComment({ id: "comment-v2", version: 2, section: "Pricing" }),
      ],
      nextCursor: null,
    });
    rpcState.list.mockResolvedValue({
      items: [{ id: "page-1", title: "Stale title" }],
      nextCursor: null,
    });

    // The list names the page, and the latest read of revision 2 carries the title from before a
    // rename.
    await mountReview("/review");
    await act(async () => {
      viewState.navigateTo?.("/review/page-1");
    });
    await act(flush);
    pinReadTime(undefined, 1_000);
    // Revision 2 is read under its own number, still under the title from before.
    await openRevision(2);
    pinReadTime(2, 2_000);
    // The page is renamed without a new revision, and the latest read repeats with the new title.
    renamed = true;
    await reopenReview();
    await vi.waitFor(() => {
      expect(cachedPageReads().get(undefined)?.state.data).toMatchObject({ title: "New title" });
    });
    pinReadTime(undefined, 3_000);
    // A new grant starts at revision 2, and revision 1 is refused.
    grant.floor = 2;
    await openRevision(1);
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("This page isn't available");
    });
    expect(listedPages()).toEqual([["page-1", "New title"]]);
  });

  it.each([
    ["pages that are not a list", { pages: "not a list" }],
    ["a page whose items are not a list", { pages: [{ items: "not a list" }] }],
  ])(
    "drops a cached shared-pages list with %s and still answers the refusal",
    async (_case, payload) => {
      let outcome: "granted" | "revoked" = "granted";
      rpcState.getReview.mockImplementation(async () => {
        if (outcome === "revoked") throw refusedPage();
        return makePage({ version: 2, currentVersion: 2 });
      });
      rpcState.list.mockResolvedValue({ items: [], nextCursor: null });

      // The list is cached. Left alone in the cache, what it holds is not shaped as the app wrote it.
      await mountReview("/review");
      await act(async () => {
        viewState.navigateTo?.("/review/page-1");
      });
      await act(flush);
      await act(async () => {
        queryClient.setQueryData(listQuery()!.queryKey, payload);
      });
      // The grant ends while the page is open.
      outcome = "revoked";
      await refreshLatestRead();
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("This page isn't available");
      });
      expect(listQuery()?.state.data).toBeUndefined();
      expect(listQuery()?.state.isInvalidated).toBe(true);
    },
  );

  // None of these answers says which revisions the reviewer may still read: a grant that ended
  // answers a plain not-found, and so does an older server.
  it.each([
    ["a plain not-found", refusedPage()],
    ["no floor", revisionRefusal()],
    ["an invalid floor", revisionRefusal("3")],
  ])(
    "clears every cached revision when a refusal for an older revision carries %s",
    async (_case, refusal) => {
      const grant = { floor: 1, current: 2, refused: false };
      let offline = false;
      rpcState.getReview.mockImplementation(async (input) => {
        if (offline) throw new Error("Failed to fetch");
        if (input.version !== undefined && grant.refused) throw refusal;
        return grantedPage(grant)(input);
      });
      rpcState.getComments.mockResolvedValue({
        items: [makeComment({ id: "comment-v1", version: 1, section: "Summary" })],
        nextCursor: null,
      });

      // The latest revision and revision 1 are cached while the reviewer may still read them.
      await mountReview("/review/page-1");
      await openRevision(1);
      await clickButton((button) => button.textContent?.includes("Back to latest") ?? false);
      grant.refused = true;
      await openRevision(1);
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("This page isn't available");
      });
      expect(
        [...cachedPageReads().values()].filter((query) => query.state.data !== undefined),
      ).toEqual([]);
      expect(cachedComments()).toEqual([]);

      // Reopened offline, none of them comes back.
      offline = true;
      await reopenReview();
      expect(document.body.textContent).toContain("This page isn't available");
      expect(document.querySelector('[data-testid="review-document"]')).toBeNull();
    },
  );
});
