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

  it("leaves a group the user marked unread alone until they open it again, like a bot", () => {
    // The automatic group read, which a new bot reply triggers, checks the hold first.
    const guard = slice(
      "const markVisibleGroupRead = () => {",
      "readVisibleGroups.current.add(groupId);",
    );
    expect(guard).toContain("manuallyUnread.current.has(groupId)");
    // Marking a message unread in an open group sets that hold.
    const fromMessage = slice("onMarkUnread={(message) => {", "} else if (active) {");
    expect(fromMessage).toContain("manuallyUnread.current.add(groupId)");
    // Opening the group clears it, so the next visit reads as usual.
    const open = slice("if (!groupId || !activeGroup) return;", "const markVisibleGroupRead");
    expect(open).toContain("manuallyUnread.current.delete(activeGroup.id)");
  });

  it("sends unread writes through the chat's read queue and skips queued reads while held", () => {
    const markBot = slice(
      "const markBotUnread = useCallback(",
      "// A bot the user marked unread by hand",
    );
    expect(markBot).toContain("readInOrder(`bot:");
    const fromMessage = slice("onMarkUnread={(message) => {", "} else if (active) {");
    expect(fromMessage).toContain("readInOrder(`group:");
    const bot = slice(
      "const markBotReadIfVisible = useCallback(",
      "const deliverBrowserNotification",
    );
    expect(bot).toContain("!manuallyUnread.current.has(id) && autoReadStillWanted(");
    const group = slice("readVisibleGroups.current.add(groupId);", ".then((answer)");
    expect(group).toContain("!manuallyUnread.current.has(groupId) && autoReadStillWanted(");
  });

  it("never lets an automatic read's answer clear a Mark as Unread hold", () => {
    const read = slice("const markBotRead = useCallback(", "const markBotUnread = useCallback(");
    const afterAnswer = read.slice(read.indexOf("const answer = await readInOrder"));
    // Only an explicit read clears the hold, before it is sent.
    expect(read).toContain("if (!stillWanted) manuallyUnread.current.delete(id);");
    expect(afterAnswer).not.toContain("manuallyUnread.current.delete(id)");
    expect(afterAnswer).toContain(
      "if (!manuallyUnread.current.has(id)) updateBotUnread(id, false);",
    );
  });

  it("drops a group's hold when its chat-list Mark as Unread fails", () => {
    const toggle = slice("onToggleUnread={() => {", "onMoveToSection=");
    const failure = toggle.slice(toggle.indexOf(".catch("));
    expect(failure).toContain("if (unread) manuallyUnread.current.delete(groupId);");
  });
});
