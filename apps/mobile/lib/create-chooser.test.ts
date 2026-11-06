import { describe, expect, it, vi } from "vitest";
import { createMenuActions, createMenuChoice, isCreateAction } from "./create-chooser";

vi.mock("./material-icons", () => ({
  materialIcons: { person_add: 101, group: 102, grid_view: 103 },
}));

const t = (text: string) => `translated: ${text}`;

describe("create menu", () => {
  it("uses SF Symbols on iOS", () => {
    expect(createMenuActions(t, "ios")).toEqual([
      { id: "bot", title: "translated: New bot", image: "person.crop.circle.badge.plus" },
      { id: "group", title: "translated: New group chat", image: "person.2" },
      { id: "space", title: "translated: New private space", image: "square.grid.2x2" },
    ]);
  });

  it("uses Material icon assets on Android in the same order", () => {
    expect(createMenuActions(t, "android").map(({ id, image }) => [id, image])).toEqual([
      ["bot", 101],
      ["group", 102],
      ["space", 103],
    ]);
  });

  it.each(["bot", "group", "space"])("accepts %s", (id) => {
    expect(isCreateAction(id)).toBe(true);
  });

  it.each(["", "other", "Bot", "person_add", "constructor"])("rejects %s", (id) => {
    expect(isCreateAction(id)).toBe(false);
  });

  it("keeps the flat items with one space", () => {
    expect(createMenuActions(t, "ios", [{ id: "space-personal", name: "Personal" }])).toEqual(
      createMenuActions(t, "ios"),
    );
  });

  it("asks which space a new bot or group chat goes in when there are several", () => {
    const spaces = [
      { id: "space-personal", name: "Personal" },
      { id: "space-work", name: "Work" },
    ];
    expect(createMenuActions(t, "ios", spaces)).toEqual([
      {
        id: "bot",
        title: "translated: New bot",
        image: "person.crop.circle.badge.plus",
        subactions: [
          { id: "bot:space-personal", title: "Personal" },
          { id: "bot:space-work", title: "Work" },
        ],
      },
      {
        id: "group",
        title: "translated: New group chat",
        image: "person.2",
        subactions: [
          { id: "group:space-personal", title: "Personal" },
          { id: "group:space-work", title: "Work" },
        ],
      },
      { id: "space", title: "translated: New private space", image: "square.grid.2x2" },
    ]);
  });

  it.each([
    ["bot", ["bot"]],
    ["space", ["space"]],
    ["bot:space-work", ["bot", "space-work"]],
    ["group:space-work", ["group", "space-work"]],
    ["space:space-work", null],
    ["bot:", null],
    ["other:space-work", null],
    ["other", null],
  ] as const)("reads the picked id %s", (id, choice) => {
    expect(createMenuChoice(id)).toEqual(choice);
  });
});
