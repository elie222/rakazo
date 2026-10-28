import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileBot } from "./api";
import { adoptDeletedSpaceFallback, rpc, selectedSpaceId, selectSpace } from "./api";
import { activateUiLocale } from "./i18n";
import type { InboxSpace } from "./inbox-spaces";
import {
  canDeleteInboxSpace,
  deleteSpaceTitle,
  inboxHasNoChats,
  inboxNeedsCreateHint,
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
  autoSpeak: false,
  fleetManagement: false,
};

describe("spaceInboxItems", () => {
  it("updates built-in headings with the locale without translating custom names", () => {
    const input = space({
      isDefault: true,
      name: "Unassigned",
      bots: [
        { ...bot, pinned: true },
        { ...bot, id: "loose" },
      ],
      botSections: [
        {
          id: "custom",
          name: "Pinned",
          position: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    try {
      activateUiLocale("de");
      expect(
        spaceInboxItems([input])
          .filter((item) => item.type === "heading")
          .map((item) => [item.key, item.title]),
      ).toEqual([
        [`${input.id}:pinned`, "Angeheftet"],
        [`${input.id}:section:custom`, "Pinned"],
        [`${input.id}:unassigned`, "Nicht zugewiesen"],
      ]);
      activateUiLocale("en");
      expect(
        spaceInboxItems([input])
          .filter((item) => item.type === "heading")
          .map((item) => item.title),
      ).toEqual(["Pinned", "Pinned", "Unassigned"]);
    } finally {
      activateUiLocale("en");
    }
  });
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
    expect(inboxNeedsCreateHint(items)).toBe(true);
  });

  it("does not ask for a create hint once a space has a bot", () => {
    expect(inboxNeedsCreateHint(spaceInboxItems([space({ isDefault: true, bots: [bot] })]))).toBe(
      false,
    );
    expect(inboxNeedsCreateHint([])).toBe(false);
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

  it("keeps empty section headings actionable only in the selected space", () => {
    const section = {
      id: "empty",
      name: "Old ideas",
      position: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const current = space({
      bots: [
        { ...bot, pinned: true },
        { ...bot, id: "loose" },
      ],
      botSections: [section],
    });
    const other = space({ id: "other", botSections: [{ ...section, id: "other-section" }] });
    const headings = spaceInboxItems([current, other], new Set(), current.id).filter(
      (item) => item.type === "heading",
    );
    expect(headings.find((item) => item.title === "Old ideas")).toMatchObject({
      sectionId: "empty",
    });
    expect(headings.filter((item) => item.sectionId).map((item) => item.sectionId)).toEqual([
      "empty",
    ]);
    expect(
      spaceInboxItems([current]).some((item) => item.type === "heading" && item.sectionId),
    ).toBe(false);
    expect(
      spaceInboxItems([space({ isDefault: true, botSections: [section] })], new Set(), current.id),
    ).toContainEqual({
      type: "heading",
      key: `${current.id}:section:empty`,
      title: "Old ideas",
      sectionId: "empty",
      collapsed: false,
      count: 0,
    });
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
    expect(items[0]).toMatchObject({ type: "bot", bot });
  });

  it("lists created bots as peers in roster order, ignoring saved parent collapse state", () => {
    const chief = { ...bot, id: "chief", parentBotId: null };
    const created = { ...bot, id: "created", parentBotId: "chief" };
    const peer = { ...bot, id: "peer", parentBotId: null };
    const items = spaceInboxItems(
      [space({ isDefault: true, bots: [created, peer, chief] })],
      new Set(["chief"]),
    );
    expect(items).toEqual([
      { type: "bot", bot: created },
      { type: "bot", bot: peer },
      { type: "bot", bot: chief },
    ]);
  });

  it("collapses one section heading and counts its chats", () => {
    const work = space({
      bots: [
        { ...bot, id: "pinned", pinned: true },
        { ...bot, id: "parent", sectionId: "section-1" },
        { ...bot, id: "child", parentBotId: "parent", sectionId: "section-1" },
        { ...bot, id: "loose" },
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
    const rows = (collapsed: Set<string>) =>
      spaceInboxItems([work], collapsed).map((item) =>
        item.type === "heading"
          ? [item.title, item.collapsed, item.count]
          : item.type === "bot"
            ? item.bot.id
            : item.type,
      );
    expect(rows(new Set())).toEqual([
      ["Work", undefined, undefined],
      ["Pinned", false, 1],
      "pinned",
      ["Research", false, 2],
      "parent",
      "child",
      ["Unassigned", false, 1],
      "loose",
    ]);
    // The space heading switches spaces, so its own key never collapses it.
    expect(
      rows(new Set([work.id, `${work.id}:section:section-1`, `${work.id}:unassigned`])),
    ).toEqual([
      ["Work", undefined, undefined],
      ["Pinned", false, 1],
      "pinned",
      ["Research", true, 2],
      ["Unassigned", true, 1],
    ]);
    expect(rows(new Set([`${work.id}:pinned`]))).toEqual([
      ["Work", undefined, undefined],
      ["Pinned", true, 1],
      ["Research", false, 2],
      "parent",
      "child",
      ["Unassigned", false, 1],
      "loose",
    ]);
  });

  it("does not ask for a create hint when every section with chats is collapsed", () => {
    const personal = space({ isDefault: true, bots: [{ ...bot, pinned: true }, bot] });
    const items = spaceInboxItems(
      [personal],
      new Set([`${personal.id}:pinned`, `${personal.id}:unassigned`]),
    );
    expect(items.every((item) => item.type === "heading")).toBe(true);
    expect(inboxNeedsCreateHint(items)).toBe(false);
    // A failed refresh must keep these headings, or the collapsed chats can't be reached.
    expect(inboxHasNoChats(items)).toBe(false);
    expect(inboxHasNoChats(spaceInboxItems([space()]))).toBe(true);
    expect(inboxHasNoChats([])).toBe(true);
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

  it("offers deletion for an explicitly authorized non-default space", () => {
    expect(canDeleteInboxSpace(space())).toBe(true);
  });

  it("offers deletion for a space that still has bots, which go with it", () => {
    expect(canDeleteInboxSpace(space({ hasContent: true, bots: [bot] }))).toBe(true);
  });

  it("names every bot deletion removes, not only the visible ones", () => {
    expect(deleteSpaceTitle(space({ bots: [bot], botCount: 3 }))).toBe(
      "Delete Work and its 3 bots?",
    );
    expect(deleteSpaceTitle(space({ bots: [], botCount: 1 }))).toBe("Delete Work and its bot?");
    expect(deleteSpaceTitle(space({ bots: [bot], botCount: 0 }))).toBe("Delete Work?");
    // Older servers send no count; fall back to the listed bots.
    expect(deleteSpaceTitle(space({ bots: [bot] }))).toBe("Delete Work and its bot?");
  });

  it("never offers deletion for the default space", () => {
    expect(canDeleteInboxSpace(space({ isDefault: true }))).toBe(false);
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
