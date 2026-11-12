import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc, alert, removeFromSearchInbox } = vi.hoisted(() => ({
  rpc: vi.fn(),
  alert: vi.fn(),
  removeFromSearchInbox: vi.fn(),
}));
vi.mock("./api-server", () => ({}));
vi.mock("./api-auth", () => ({}));
vi.mock("./api-live", () => ({}));
vi.mock("./api", () => ({ rpc }));
vi.mock("./search-inbox", () => ({ removeFromSearchInbox }));
vi.mock("react-native", () => ({ Alert: { alert } }));
vi.mock("./user-error", () => ({ errorText: () => "Try again." }));

import { confirmDeleteBot, confirmDeleteGroup, restoreArchivedBot } from "./bot-lifecycle";

beforeEach(() => {
  vi.resetAllMocks();
  rpc.mockResolvedValue([]);
});
describe("archived bot lifecycle", () => {
  it("waits for restore and propagates failure instead of opening a writable chat", async () => {
    rpc.mockResolvedValueOnce({ ok: true });
    await restoreArchivedBot("bot-fixture");
    expect(rpc).toHaveBeenCalledWith("bots/restore", { botId: "bot-fixture" });
    rpc.mockRejectedValueOnce(new Error("offline"));
    await expect(restoreArchivedBot("bot-fixture")).rejects.toThrow("offline");
  });
  it("cancel never removes a bot, and both deletion choices are destructive", async () => {
    await confirmDeleteBot({ id: "bot-fixture", name: "Fixture" }, vi.fn());
    expect(rpc).toHaveBeenCalledExactlyOnceWith("bots/removePreview", { botId: "bot-fixture" });
    const buttons = alert.mock.calls[0]![2];
    expect(buttons.map((button: { style: string }) => button.style)).toEqual([
      "cancel",
      "destructive",
      "destructive",
    ]);
  });
  it("removes the row only after the selected deletion succeeds", async () => {
    const deleted = vi.fn();
    rpc.mockResolvedValueOnce([]).mockResolvedValueOnce({ ok: true });
    await confirmDeleteBot({ id: "bot-fixture", name: "Fixture" }, deleted);
    await alert.mock.calls[0]![2][1].onPress();
    await Promise.resolve();
    expect(rpc).toHaveBeenCalledWith("bots/remove", {
      botId: "bot-fixture",
      deleteMemories: false,
    });
    expect(removeFromSearchInbox).toHaveBeenCalledWith("bot-fixture");
    expect(deleted).toHaveBeenCalledOnce();
  });
});

describe("group deletion", () => {
  it("asks with a named deletion title and retention message and removes nothing on cancel", () => {
    const deleted = vi.fn();
    confirmDeleteGroup({ id: "group-fixture", name: "Team" }, deleted);
    const [title, message, buttons] = alert.mock.calls[0]!;
    expect([title, message]).toEqual(["Delete Team?", "Bots and their own chats stay."]);
    expect(
      buttons.map(({ text, style }: { text: string; style: string }) => [text, style]),
    ).toEqual([
      ["Cancel", "cancel"],
      ["Delete", "destructive"],
    ]);
    expect(rpc).not.toHaveBeenCalled();
    expect(deleted).not.toHaveBeenCalled();
  });

  it("removes the group only after Delete succeeds, and alerts on failure", async () => {
    const deleted = vi.fn();
    rpc.mockResolvedValueOnce({ ok: true });
    confirmDeleteGroup({ id: "group-fixture", name: "Team" }, deleted);
    alert.mock.calls[0]![2][1].onPress();
    await vi.waitFor(() => expect(deleted).toHaveBeenCalledOnce());
    expect(rpc).toHaveBeenCalledWith("groups/remove", { groupId: "group-fixture" });
    expect(removeFromSearchInbox).toHaveBeenCalledWith("group-fixture");

    rpc.mockRejectedValueOnce(new Error("offline"));
    confirmDeleteGroup({ id: "group-fixture", name: "Team" }, deleted);
    alert.mock.calls[1]![2][1].onPress();
    await vi.waitFor(() => expect(alert).toHaveBeenCalledTimes(3));
    expect(alert.mock.calls[2]!.slice(0, 2)).toEqual(["Could not delete group", "Try again."]);
    expect(deleted).toHaveBeenCalledOnce();
    expect(removeFromSearchInbox).toHaveBeenCalledOnce();
  });
});

it("keeps deletion bound to the archived bot's space through confirmation", async () => {
  const requestContext = {
    apiBase: "https://example.test",
    headers: { "x-rakazo-space-id": "space-b" },
  };
  const deleted = vi.fn();
  rpc.mockResolvedValueOnce([]).mockResolvedValueOnce({ ok: true });
  await confirmDeleteBot({ id: "bot-b", name: "Bot" }, deleted, () => true, requestContext);
  await alert.mock.calls[0]![2][1].onPress();
  await Promise.resolve();
  expect(rpc).toHaveBeenCalledWith(
    "bots/remove",
    { botId: "bot-b", deleteMemories: false },
    {
      requestContext,
      skipSpaceAuthRecovery: true,
    },
  );
  expect(deleted).toHaveBeenCalledOnce();
  expect(rpc).toHaveBeenCalledWith(
    "bots/removePreview",
    { botId: "bot-b" },
    { requestContext, skipSpaceAuthRecovery: true },
  );
});

describe("bot deletion preview", () => {
  it.each([
    [
      [{ id: "g1", name: "Alpha" }],
      "The group Alpha will be deleted too, including its messages, files, and pages.",
    ],
    [
      [
        { id: "g1", name: "Alpha" },
        { id: "g2", name: "Beta" },
      ],
      "The groups Alpha, Beta will be deleted too, including their messages, files, and pages.",
    ],
  ])("names the affected groups before confirmation", async (groups, warning) => {
    rpc.mockResolvedValueOnce(groups);
    await confirmDeleteBot({ id: "bot-fixture", name: "Fixture" }, vi.fn());
    expect(alert.mock.calls[0]![1]).toContain(warning);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("bots/removePreview", { botId: "bot-fixture" });
  });

  it("leaves the description unchanged when no groups are removed", async () => {
    await confirmDeleteBot({ id: "bot-fixture", name: "Fixture" }, vi.fn());
    expect(alert.mock.calls[0]![1]).toBe(
      "Its conversation, files, and routines will be permanently deleted. What should happen to its memories?",
    );
  });

  it("waits for the preview before offering destructive choices", async () => {
    let resolve!: (value: unknown[]) => void;
    rpc.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = confirmDeleteBot({ id: "bot-fixture", name: "Fixture" }, vi.fn());
    expect(alert).not.toHaveBeenCalled();
    resolve([]);
    await pending;
    expect(alert).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledOnce();
  });

  it("warns about groups if the preview fails and keeps both memory choices", async () => {
    rpc.mockRejectedValueOnce(new Error("offline"));
    const deleted = vi.fn();
    await confirmDeleteBot({ id: "bot-fixture", name: "Fixture" }, deleted);
    expect(alert.mock.calls[0]![1]).toContain(
      "Groups left with fewer than two bots are deleted too, including their messages, files, and pages.",
    );
    alert.mock.calls[0]![2][2].onPress();
    await vi.waitFor(() => expect(deleted).toHaveBeenCalledOnce());
    expect(rpc).toHaveBeenLastCalledWith("bots/remove", {
      botId: "bot-fixture",
      deleteMemories: true,
    });
  });

  it.each([false, true])(
    "does not open a late preview after leaving the screen (failure=%s)",
    async (fails) => {
      let finish!: () => void;
      rpc.mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            finish = () => (fails ? reject(new Error("offline")) : resolve([]));
          }),
      );
      let current = true;
      const pending = confirmDeleteBot(
        { id: "bot-fixture", name: "Fixture" },
        vi.fn(),
        () => current,
      );
      current = false;
      finish();
      await pending;
      expect(alert).not.toHaveBeenCalled();
    },
  );
});
