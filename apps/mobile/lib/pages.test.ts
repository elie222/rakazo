import type { PageDetail } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({ rpc: vi.fn() }));
const sessionCaches: Array<() => void> = [];
vi.mock("./session", () => ({
  registerSessionDiskCache: (clear: () => void) => sessionCaches.push(clear),
}));

const {
  pageCardState,
  pageMessage,
  pageReadFailure,
  pagePreviewLayout,
  pageShareLink,
  pageShareState,
  reducePageShare,
} = await import("./pages");

const detail = (overrides: Partial<PageDetail> = {}): PageDetail => ({
  id: "page-1",
  title: "Duplex voice build",
  botId: "bot-1",
  groupId: null,
  visibility: "private",
  currentVersion: 2,
  pinned: false,
  createdAt: "2026-10-30T10:00:00.000Z",
  updatedAt: "2026-10-30T11:00:00.000Z",
  version: 2,
  code: "exports.default = () => null;",
  owner: { name: "RJ", image: null },
  shareUrl: null,
  ...overrides,
});

describe("pagePreviewLayout", () => {
  it("shows the page's top at 1200:630, laid out 1/0.6 wider and scaled back to the card", () => {
    expect(pagePreviewLayout(390)).toEqual({
      height: 204.75,
      frameWidth: 650,
      frameHeight: 341.25,
      scale: 0.6,
    });
    const ipad = pagePreviewLayout(638);
    expect(ipad.frameWidth * ipad.scale).toBeCloseTo(638);
    expect(ipad.frameHeight * ipad.scale).toBeCloseTo(ipad.height);
  });
});

describe("pageCardState", () => {
  it("names the page by its current title and tells deleted from failed", () => {
    expect(pageReadFailure({ code: "NOT_FOUND" })).toBe("deleted");
    expect(pageReadFailure(new Error("offline"))).toBe("failed");
    expect(pageCardState({ version: 1, title: "Gone" }, "deleted")).toEqual({
      status: "deleted",
      title: "Gone",
    });
    expect(pageCardState({ version: 1, title: "Old title" }, null)).toEqual({
      status: "loading",
      title: "Old title",
    });
    expect(pageCardState({ version: 1, title: "Old title" }, "failed")).toEqual({
      status: "failed",
      title: "Old title",
    });
    // A newer version alone does not make a card older: only a later card in the chat does.
    expect(pageCardState({ version: 1, title: "Old title" }, detail())).toEqual({
      status: "ready",
      title: "Duplex voice build",
      detail: detail(),
    });
  });
});

describe("pageMessage", () => {
  it("reads a WebView message, and nothing from text that is not one", () => {
    const link = { type: "rakazo-page:open-link", url: "https://example.com/" };
    expect(pageMessage(JSON.stringify(link))).toEqual(link);
    expect(pageMessage("not json")).toBeNull();
  });
});

describe("reducePageShare", () => {
  it("offers the link only once the server made the page public", () => {
    let state = pageShareState(detail());
    expect(pageShareLink(state)).toBeNull();
    const reopened = reducePageShare(state, {
      type: "loaded",
      visibility: "link",
      shareUrl: "https://rakazo.example/p/voice-old",
    });
    expect(pageShareLink(reopened)).toBe("https://rakazo.example/p/voice-old");
    state = reducePageShare(state, { type: "choose", visibility: "link" });
    expect(state.pending).toBe("link");
    expect(pageShareLink(state)).toBeNull();
    state = reducePageShare(state, {
      type: "saved",
      visibility: "link",
      shareUrl: "https://rakazo.example/p/voice-abc",
    });
    expect(pageShareLink(state)).toBe("https://rakazo.example/p/voice-abc");
    state = reducePageShare(state, { type: "choose", visibility: "private" });
    expect(pageShareLink(state)).toBeNull();
    // Not saved: the server, asked again, still has the link on.
    state = reducePageShare(state, {
      type: "failed",
      visibility: "private",
      actual: { visibility: "link", shareUrl: "https://rakazo.example/p/voice-abc" },
    });
    expect(state).toMatchObject({ visibility: "link", error: true, pending: null });
    expect(pageShareLink(state)).toBe("https://rakazo.example/p/voice-abc");
  });

  it("ignores a late answer for a choice the user already changed", () => {
    let state = reducePageShare(pageShareState(detail()), { type: "choose", visibility: "link" });
    state = reducePageShare(state, { type: "choose", visibility: "private" });
    const late = reducePageShare(state, {
      type: "saved",
      visibility: "link",
      shareUrl: "https://rakazo.example/p/x",
    });
    expect(late).toBe(state);
    expect(reducePageShare(state, { type: "failed", visibility: "link", actual: null })).toBe(
      state,
    );
  });
});

describe("getLatestPage", () => {
  it("reads again for a card newer than the cached page, and forgets pages on a session change", async () => {
    const { rpc } = await import("./api");
    const read = vi.mocked(rpc);
    const { getLatestPage } = await import("./pages");
    const at = (currentVersion: number) => ({ id: "p1", currentVersion }) as PageDetail;
    read.mockResolvedValueOnce(at(1) as never);
    expect((await getLatestPage("p1")).currentVersion).toBe(1);
    // A card for version 1 uses the cache; one for version 2 must not show version 1.
    expect((await getLatestPage("p1", { atLeastVersion: 1 })).currentVersion).toBe(1);
    expect(read).toHaveBeenCalledTimes(1);
    read.mockResolvedValueOnce(at(2) as never);
    expect((await getLatestPage("p1", { atLeastVersion: 2 })).currentVersion).toBe(2);
    expect(read).toHaveBeenCalledTimes(2);

    for (const clear of sessionCaches) clear();
    read.mockResolvedValueOnce(at(2) as never);
    await getLatestPage("p1");
    expect(read).toHaveBeenCalledTimes(3);
  });
});

describe("removePage", () => {
  it("treats a page deleted on another device first as deleted, not as a failure", async () => {
    const { rpc } = await import("./api");
    const { removePage } = await import("./pages");
    vi.mocked(rpc).mockRejectedValueOnce({ code: "NOT_FOUND" } as never);
    await expect(removePage("p1")).resolves.toEqual({ ok: true });
    vi.mocked(rpc).mockRejectedValueOnce(new Error("offline") as never);
    await expect(removePage("p1")).rejects.toThrow("offline");
  });
});
