import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { autoReadStillWanted } from "./auto-read";

const page = (visibilityState: DocumentVisibilityState, focused: boolean) => ({
  visibilityState,
  hasFocus: () => focused,
});

describe("autoReadStillWanted", () => {
  it("reads only on the same visit with the window shown and focused", () => {
    expect(autoReadStillWanted(3, 3, page("visible", true))).toBe(true);
    expect(autoReadStillWanted(4, 3, page("visible", true))).toBe(false);
    expect(autoReadStillWanted(3, 3, page("hidden", true))).toBe(false);
    // A queued group read used to skip only this check: the tab is shown but another window has focus.
    expect(autoReadStillWanted(3, 3, page("visible", false))).toBe(false);
  });
});

describe("queued automatic reads", () => {
  const shell = readFileSync(new URL("../pages/Shell.tsx", import.meta.url), "utf8");
  const slice = (start: string, end: string) => {
    const from = shell.indexOf(start);
    expect(from).toBeGreaterThan(-1);
    return shell.slice(from, shell.indexOf(end, from));
  };

  it("check visit, visibility and focus the same way for bot and group chats", () => {
    const bot = slice(
      "const markBotReadIfVisible = useCallback(",
      "const deliverBrowserNotification",
    );
    const group = slice("readVisibleGroups.current.add(groupId);", ".then((answer)");
    expect(bot).toContain("autoReadStillWanted(readVisit.current.visit, visit)");
    expect(group).toContain("autoReadStillWanted(readVisit.current.visit, visit)");
  });
});
