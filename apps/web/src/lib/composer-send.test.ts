// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { clearComposerSend, readComposerSend, saveComposerSend } from "./composer-send";

const scope = { server: "https://example.test", userId: "user-1", spaceId: "selected-space" };
const context = { reply: null, quote: null, page: null, attachments: [] };
const envelope = {
  procedure: "send" as const,
  body: { botId: "bot-1", text: "notes", clientNonce: "original" },
};
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});
it.each([
  { ...scope, userId: "other" },
  { ...scope, spaceId: "bootstrap-space" },
  { ...scope, server: "https://other.test" },
  { ...scope, userId: "" },
  { ...scope, spaceId: null },
  { ...scope, server: "null" },
])("never replays outside the explicit authenticated scope: %j", (other) => {
  saveComposerSend("bot:bot-1", scope, context, envelope);
  expect(readComposerSend("bot:bot-1", other)).toBeNull();
});
it("rejects copied targets and invalid serialized contract bodies", () => {
  saveComposerSend("bot:bot-1", scope, context, envelope);
  const raw = localStorage.getItem("rakazo.composerSend.bot:bot-1")!;
  localStorage.setItem("rakazo.composerSend.bot:bot-2", raw);
  expect(readComposerSend("bot:bot-2", scope)).toBeNull();
  for (const body of [
    { ...envelope.body, groupId: "g" },
    { ...envelope.body, botId: "other-target" },
    { ...envelope.body, text: 12 },
    { ...envelope.body, text: "" },
  ]) {
    localStorage.setItem(
      "rakazo.composerSend.bot:bot-1",
      JSON.stringify({ ...JSON.parse(raw), envelope: { procedure: "send", body } }),
    );
    expect(readComposerSend("bot:bot-1", scope)).toBeNull();
  }
});
it("does not let an old acceptance clear a newer envelope", () => {
  saveComposerSend("bot:bot-1", scope, context, {
    ...envelope,
    body: { ...envelope.body, clientNonce: "new" },
  });
  clearComposerSend("bot:bot-1", "original");
  expect(readComposerSend("bot:bot-1", scope)?.envelope.body.clientNonce).toBe("new");
});
it("fails closed without identity and tolerates unavailable storage", () => {
  saveComposerSend("bot:bot-1", { ...scope, userId: "" }, context, envelope);
  expect(localStorage.length).toBe(0);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  expect(() => saveComposerSend("bot:bot-1", scope, context, envelope)).not.toThrow();
  expect(readComposerSend("bot:bot-1", scope)).toBeNull();
});
