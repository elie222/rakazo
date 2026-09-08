import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  adoptDeletedSpaceFallback,
  type MobileBot,
  rpc,
  selectedSpaceId,
  selectSpace,
} from "./api";
import {
  canDeleteInboxSpace,
  type InboxSpace,
  removeInboxSpace,
  retryInboxSpaceFallback,
  selectInboxSpace,
  spaceInboxItems,
} from "./inbox-spaces";

vi.mock("./api", () => ({
  adoptDeletedSpaceFallback: vi.fn(),
  rpc: vi.fn(),
  selectedSpaceId: vi.fn(),
  selectSpace: vi.fn(),
}));

function space(overrides: Partial<InboxSpace> = {}): InboxSpace {
  return {
    id: "space-work",
    name: "Work",
    isDefault: false,
    hasContent: false,
    canDelete: true,
    bots: [],
    groups: [],
    botSections: [],
    ...overrides,
  };
}

const bot: MobileBot = {
  id: "bot-1",
  name: "Helper",
  preview: "",
  title: "",
  color: "gray",
  computerMode: "team",
  notifyOnFinish: true,
  threadId: "thread-1",
  pinned: false,
  status: "idle",
  sectionId: null,
  archivedAt: null,
  unread: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
  modelProvider: null,
  modelId: null,
  thinkingLevel: null,
};

describe("spaceInboxItems", () => {
  it("keeps an empty space visible and selectable by its own id", () => {
    const empty = space();
    expect(spaceInboxItems([empty])).toEqual([
      { type: "heading", key: empty.id, title: empty.name, space: empty },
    ]);
  });

  it("keeps the only empty default space visible without offering deletion", () => {
    const personal = space({ isDefault: true, canDelete: true });
    const items = spaceInboxItems([personal]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "heading", space: personal });
    expect(canDeleteInboxSpace(personal)).toBe(false);
  });

  it("renders space actions once, separate from pinned and named bot sections", () => {
    const work = space({
      bots: [
        { ...bot, pinned: true },
        { ...bot, id: "bot-2", sectionId: "section-1" },
      ],
      botSections: [
        {
          id: "section-1",
          name: "Research",
          position: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const headings = spaceInboxItems([work]).filter((item) => item.type === "heading");
    expect(headings.map((item) => item.title)).toEqual(["Work", "Pinned", "Research"]);
    expect(headings.filter((item) => item.space)).toEqual([
      { type: "heading", key: work.id, title: work.name, space: work },
    ]);
  });

  it("keeps populated default-space chrome minimal and retains group rows", () => {
    const group = {
      id: "group-1",
      name: "Planning",
      preview: "",
      pinned: false,
      sectionId: null,
      archivedAt: null,
      unread: false,
      updatedAt: "2026-01-01T00:00:00.000Z",
      members: [],
    };
    const items = spaceInboxItems([space({ isDefault: true, bots: [bot], groups: [group] })]);
    expect(items.map((item) => item.type)).toEqual(["bot", "group"]);
  });

  it("keeps empty spaces beside a populated space", () => {
    const personal = space({ id: "personal", isDefault: true, bots: [bot] });
    expect(spaceInboxItems([personal, space()]).map((item) => item.type)).toEqual([
      "heading",
      "bot",
      "heading",
    ]);
  });

  it.each([undefined, false])("hides deletion unless ownership is explicit (%s)", (canDelete) => {
    expect(canDeleteInboxSpace(space({ canDelete }))).toBe(false);
  });

  it("offers deletion for an explicitly authorized empty non-default space", () => {
    expect(canDeleteInboxSpace(space())).toBe(true);
  });

  it("hides deletion while a space still has content", () => {
    expect(canDeleteInboxSpace(space({ hasContent: true }))).toBe(false);
  });
});

describe("removeInboxSpace", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(selectedSpaceId).mockReturnValue("space-work");
    vi.mocked(rpc).mockResolvedValue({ ok: true, activeSpaceId: "personal" });
    vi.mocked(selectSpace).mockResolvedValue(true);
    vi.mocked(adoptDeletedSpaceFallback).mockResolvedValue(true);
  });

  it("awaits saving the server fallback before refreshing a deleted current space", async () => {
    let finishSelection!: (saved: boolean) => void;
    vi.mocked(selectSpace).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSelection = resolve;
        }),
    );
    const refresh = vi.fn(async () => undefined);
    const removing = removeInboxSpace("space-work", refresh);
    await vi.waitFor(() => expect(selectSpace).toHaveBeenCalledWith("personal"));
    expect(refresh).not.toHaveBeenCalled();
    finishSelection(true);
    await expect(removing).resolves.toBeNull();
    expect(rpc).toHaveBeenCalledWith("spaces/remove", { spaceId: "space-work" });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("keeps the selection when deleting another space", async () => {
    vi.mocked(selectedSpaceId).mockReturnValue("personal");
    const refresh = vi.fn(async () => undefined);
    await expect(removeInboxSpace("space-work", refresh)).resolves.toBeNull();
    expect(selectSpace).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("adopts and refreshes the server fallback when direct persistence fails", async () => {
    vi.mocked(selectSpace).mockResolvedValue(false);
    const refresh = vi.fn(async () => undefined);
    await expect(removeInboxSpace("space-work", refresh)).resolves.toBeNull();
    expect(adoptDeletedSpaceFallback).toHaveBeenCalledWith("personal");
    expect(refresh).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledOnce();
  });

  it("retains a retry when neither fallback recovery write is durable", async () => {
    vi.mocked(selectSpace).mockResolvedValue(false);
    vi.mocked(adoptDeletedSpaceFallback).mockResolvedValue(false);
    const refresh = vi.fn(async () => undefined);
    const recoveryId = await removeInboxSpace("space-work", refresh);
    expect(recoveryId).toBe("personal");
    expect(refresh).toHaveBeenCalledOnce();
    vi.mocked(adoptDeletedSpaceFallback).mockResolvedValue(true);
    await expect(retryInboxSpaceFallback(recoveryId!, refresh)).resolves.toBe(true);
    expect(adoptDeletedSpaceFallback).toHaveBeenCalledTimes(2);
    expect(adoptDeletedSpaceFallback).toHaveBeenLastCalledWith("personal");
    expect(selectSpace).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledOnce();
  });

  it("keeps the retry visible when fallback persistence still fails", async () => {
    vi.mocked(adoptDeletedSpaceFallback).mockResolvedValue(false);
    const refresh = vi.fn(async () => undefined);
    await expect(retryInboxSpaceFallback("personal", refresh)).resolves.toBe(false);
    expect(refresh).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("selects an empty inbox without creating a bot or starting onboarding", async () => {
    const refresh = vi.fn(async () => undefined);
    await expect(selectInboxSpace("space-work", refresh)).resolves.toBe(true);
    expect(selectSpace).toHaveBeenCalledWith("space-work");
    expect(refresh).toHaveBeenCalledOnce();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("does not refresh when selecting an empty space fails", async () => {
    vi.mocked(selectSpace).mockResolvedValue(false);
    const refresh = vi.fn(async () => undefined);
    await expect(selectInboxSpace("space-work", refresh)).resolves.toBe(false);
    expect(refresh).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("also adopts the fallback when native selection throws", async () => {
    vi.mocked(selectSpace).mockRejectedValue(new Error("storage unavailable"));
    const refresh = vi.fn(async () => undefined);
    await expect(removeInboxSpace("space-work", refresh)).resolves.toBeNull();
    expect(adoptDeletedSpaceFallback).toHaveBeenCalledWith("personal");
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("leaves selection and inbox unchanged when deletion is rejected", async () => {
    vi.mocked(rpc).mockRejectedValue(new Error("Space is not empty"));
    const refresh = vi.fn(async () => undefined);
    await expect(removeInboxSpace("space-work", refresh)).rejects.toThrow("Space is not empty");
    expect(selectSpace).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});
