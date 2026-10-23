import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const thread = readFileSync(new URL("../app/thread.tsx", import.meta.url), "utf8");
const slice = (start: string, end: string) => {
  const from = thread.indexOf(start);
  expect(from).toBeGreaterThan(-1);
  return thread.slice(from, thread.indexOf(end, from));
};

it("holds a chat marked unread from a message for that visit only", () => {
  // Marking names the current visit…
  const mark = slice("const markUnreadFrom = (message: MobileMessage) => {", "};");
  expect(mark).toContain("heldUnread.current = visit;");
  // …and the automatic read skips only while that same visit lasts, so coming back to the
  // chat (a new visit) reads it and captures where the New divider goes.
  const read = slice(
    "const markReadIfVisible = useCallback(() => {",
    "const target = groupId ?? botId;",
  );
  expect(read).toContain("heldUnread.current === readVisit.current.visit");
  expect(thread).not.toContain("heldUnread.current = true");
});

it("sends the unread write through the chat's read queue and skips queued reads while held", () => {
  const mark = slice(
    "const markUnreadFrom = (message: MobileMessage) => {",
    "const markReadIfVisible",
  );
  expect(mark).toContain("readInOrder(target, () =>");
  const queued = slice(
    "void readInOrder(target, () =>\n      readVisit.current.visit === visit",
    ": Promise.resolve(null)",
  );
  expect(queued).toContain("heldUnread.current !== visit");
});
