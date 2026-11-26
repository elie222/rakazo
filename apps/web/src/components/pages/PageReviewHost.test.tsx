// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import type { PageComment, PageReview, PageSectionAnchor } from "@rakazo/contracts";
import { deferred, flush } from "@rakazo/core/test-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PageReviewHost from "./PageReviewHost";

const rpcState = vi.hoisted(() => ({
  spaceId: "space-1",
  getReview: vi.fn<(input: { pageId: string; version?: number }) => Promise<PageReview>>(),
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
  const client = {
    notifications: {
      subscribe: async () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => deferred<IteratorResult<never>>().promise,
        }),
      }),
    },
    pageReviews: {
      get: (input: { pageId: string; version?: number }) => rpcState.getReview(input),
      comments: (input: { pageId: string; cursor?: string }) => rpcState.getComments(input),
      draft: (input: { pageId: string; requestId: string }) => rpcState.getDraft(input),
      comment: (input: Record<string, unknown>) => rpcState.addComment(input),
      publish: (input: { pageId: string; requestId: string }) => rpcState.publish(input),
      resolve: vi.fn(),
      askRevision: vi.fn(),
      list: vi.fn(async () => ({ items: [], nextCursor: null })),
      image: vi.fn(),
      saveState: (input: Record<string, unknown>) => rpcState.saveState(input),
    },
    pages: {
      get: vi.fn(),
    },
  };
  return {
    rpc: client,
    selectedSpaceId: () => rpcState.spaceId,
    rpcForSpace: () => client,
    createSpaceRpc: () => client,
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
  rpcState.getReview.mockReset();
  rpcState.getComments.mockReset();
  rpcState.getDraft.mockReset();
  rpcState.addComment.mockReset();
  rpcState.publish.mockReset();
  rpcState.saveState.mockReset();
  rpcState.getReview.mockResolvedValue(makePage());
  rpcState.getComments.mockResolvedValue({ items: [], nextCursor: null });
  rpcState.getDraft.mockResolvedValue({ code: "<main>draft</main>", images: {}, version: 1 });
  rpcState.addComment.mockResolvedValue(undefined);
  rpcState.publish.mockResolvedValue(undefined);
  rpcState.saveState.mockResolvedValue(undefined);
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
});
