import { describe, expect, it, vi } from "vitest";
import { commitSpaceRename, sidebarGroupsForSpaces } from "./space-sidebar";

function chat(id: string, name: string) {
  return {
    id,
    name,
    title: "",
    preview: "",
    pinned: false,
    sectionId: null,
    parentBotId: null,
  };
}

function space(
  id: string,
  name: string,
  options: { canRename?: boolean; canDelete?: boolean; bots?: ReturnType<typeof chat>[] } = {},
) {
  return {
    id,
    name,
    canRename: options.canRename ?? false,
    canDelete: options.canDelete ?? false,
    bots: options.bots ?? [chat(`${id}-bot`, "Chief")],
    groups: [],
    botSections: [],
  };
}

describe("sidebarGroupsForSpaces", () => {
  it("keeps an empty space with saved sections openable", () => {
    const empty = {
      ...space("space-2", "Support", { canRename: true, bots: [] }),
      botSections: [{ id: "saved", name: "Archived projects" }],
    };
    const groups = sidebarGroupsForSpaces([space("space-1", "Personal"), empty], "");
    expect(groups.filter((group) => group.spaceId === empty.id)).toEqual([
      expect.objectContaining({ emptySpaceId: "space-2", title: "Support" }),
      expect.objectContaining({
        sectionId: "saved",
        title: "Support · Archived projects",
        bots: [],
        emptySpaceId: undefined,
      }),
    ]);
  });

  it("keeps an empty section deletable when the only space has no chats", () => {
    const input = {
      ...space("space-1", "Personal", { bots: [] }),
      botSections: [{ id: "old", name: "Old ideas" }],
    };
    expect(sidebarGroupsForSpaces([input], "")).toEqual([
      expect.objectContaining({ key: "section:old", sectionId: "old", title: "Old ideas" }),
    ]);
    expect(sidebarGroupsForSpaces([input], "Old")).toEqual([]);
  });

  it("retains empty section and Unassigned drop targets when not searching", () => {
    const input = {
      ...space("space-1", "Personal"),
      bots: [{ ...chat("a", "Alpha"), sectionId: "s1" }],
      botSections: [
        { id: "s1", name: "Projects" },
        { id: "s2", name: "Empty" },
      ],
    };
    expect(sidebarGroupsForSpaces([input], "").map((group) => group.key)).toEqual([
      "section:s1",
      "section:s2",
      "unassigned",
    ]);
    expect(sidebarGroupsForSpaces([input], "Alpha").map((group) => group.key)).toEqual([
      "section:s1",
    ]);
  });

  it("keeps rename on the only space without showing its name", () => {
    const [group] = sidebarGroupsForSpaces([space("space-1", "Personal", { canRename: true })], "");

    expect(group).toMatchObject({
      title: null,
      spaceName: "Personal",
      canRenameSpace: true,
      canDeleteSpace: false,
      showLock: false,
    });
    expect(group?.bots).toHaveLength(1);
  });

  it("still names each space once there is more than one", () => {
    const groups = sidebarGroupsForSpaces(
      [
        space("space-1", "Personal", { canRename: true }),
        space("space-2", "Support", { canRename: true, canDelete: true, bots: [] }),
      ],
      "",
    );

    expect(groups.map((group) => group.title)).toEqual(["Personal", "Support"]);
    expect(groups[0]).toMatchObject({ canRenameSpace: true, canDeleteSpace: false });
    expect(groups[1]).toMatchObject({
      canRenameSpace: true,
      canDeleteSpace: true,
      emptySpaceId: "space-2",
    });
  });

  it("keeps the space menu for a member who cannot rename or delete, for Settings", () => {
    const groups = sidebarGroupsForSpaces(
      [space("space-1", "Personal", { canRename: true }), space("space-2", "Shared")],
      "",
    );

    expect(groups[1]).toMatchObject({
      title: "Shared",
      canRenameSpace: false,
      canDeleteSpace: false,
      canOpenSpaceSettings: true,
    });
  });

  it("keeps settings reachable in a member's only empty space", () => {
    expect(sidebarGroupsForSpaces([space("space-1", "Shared", { bots: [] })], "")).toEqual([
      expect.objectContaining({
        title: null,
        spaceName: "Shared",
        canRenameSpace: false,
        canDeleteSpace: false,
        canOpenSpaceSettings: true,
      }),
    ]);
  });

  it("hides space actions while a search removes every chat from the only space", () => {
    expect(
      sidebarGroupsForSpaces([space("space-1", "Personal", { canRename: true })], "missing"),
    ).toEqual([]);
  });
});

describe("commitSpaceRename", () => {
  it("applies the saved name when the following refresh fails", async () => {
    const rename = vi.fn(async () => undefined);
    const apply = vi.fn();
    const refresh = vi.fn(async () => {
      throw new Error("list failed");
    });

    await expect(commitSpaceRename({ rename, apply, refresh })).resolves.toBeUndefined();
    expect(rename).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("does not apply a name when the rename itself fails", async () => {
    const apply = vi.fn();
    const refresh = vi.fn(async () => undefined);

    await expect(
      commitSpaceRename({
        rename: async () => {
          throw new Error("Space deletion is already in progress");
        },
        apply,
        refresh,
      }),
    ).rejects.toThrow("Space deletion is already in progress");
    expect(apply).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});
