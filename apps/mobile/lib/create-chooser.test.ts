import { afterEach, describe, expect, it, vi } from "vitest";
import { createMenuActions, isCreateAction } from "./create-chooser";
import { resetI18nForTests } from "./i18n";

vi.mock("./material-icons", () => ({
  materialIcons: { person_add: 101, group: 102, grid_view: 103 },
}));

afterEach(() => resetI18nForTests());

describe("create menu", () => {
  it("uses SF Symbols on iOS, in the app language", () => {
    resetI18nForTests("de");
    expect(createMenuActions("ios")).toEqual([
      { id: "bot", title: "Neuer Bot", image: "person.crop.circle.badge.plus" },
      { id: "group", title: "Neuer Gruppenchat", image: "person.2" },
      { id: "space", title: "Neuer privater Space", image: "square.grid.2x2" },
    ]);
  });

  it("uses Material icon assets on Android in the same order", () => {
    expect(createMenuActions("android").map(({ id, image }) => [id, image])).toEqual([
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
});
