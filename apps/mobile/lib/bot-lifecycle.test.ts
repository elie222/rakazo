import { i18n } from "@lingui/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc, alert, removeFromSearchInbox, captureApiRequestContext } = vi.hoisted(() => ({
  rpc: vi.fn(),
  captureApiRequestContext: vi.fn(),
  alert: vi.fn(),
  removeFromSearchInbox: vi.fn(),
}));
const session = vi.hoisted(() => ({ generation: 2 }));
vi.mock("./session", () => ({ currentSessionGeneration: () => session.generation }));
vi.mock("./api-server", () => ({}));
vi.mock("./api-auth", () => ({}));
vi.mock("./api-live", () => ({}));
vi.mock("./api", () => ({ rpc, captureApiRequestContext }));
vi.mock("./search-inbox", () => ({ removeFromSearchInbox }));
vi.mock("react-native", () => ({ Alert: { alert } }));
vi.mock("./user-error", () => ({ errorText: () => "Try again." }));

import { confirmDeleteBot, confirmDeleteGroup, restoreArchivedBot } from "./bot-lifecycle";

beforeEach(() => {
  i18n.load("en", {});
  i18n.activate("en");
  session.generation = 2;
  vi.resetAllMocks();
  rpc.mockResolvedValue([]);
  captureApiRequestContext.mockResolvedValue({
    apiBase: "https://example.test",
    headers: { "x-rakazo-space-id": "space-a" },
  });
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
    expect(rpc).toHaveBeenCalledExactlyOnceWith(
      "bots/removePreview",
      { botId: "bot-fixture" },
      expect.objectContaining({ skipSpaceAuthRecovery: true }),
    );
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
    expect(rpc).toHaveBeenCalledWith(
      "bots/remove",
      {
        botId: "bot-fixture",
        deleteMemories: false,
      },
      expect.objectContaining({ skipSpaceAuthRecovery: true }),
    );
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
    expect(rpc).toHaveBeenCalledExactlyOnceWith(
      "bots/removePreview",
      { botId: "bot-fixture" },
      expect.objectContaining({ skipSpaceAuthRecovery: true }),
    );
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
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledOnce());
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
    expect(rpc).toHaveBeenLastCalledWith(
      "bots/remove",
      {
        botId: "bot-fixture",
        deleteMemories: true,
      },
      expect.objectContaining({ skipSpaceAuthRecovery: true }),
    );
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
      await vi.waitFor(() => expect(rpc).toHaveBeenCalledOnce());
      current = false;
      finish();
      await pending;
      expect(alert).not.toHaveBeenCalled();
    },
  );
});

it.each(["cancel", "dismiss", "success", "failure", "stale"] as const)(
  "releases the confirmation guard on %s",
  async (outcome) => {
    const finished = vi.fn();
    await confirmDeleteBot(
      { id: "fixture", name: "Fixture" },
      vi.fn(),
      () => outcome !== "stale",
      undefined,
      finished,
    );
    if (outcome === "cancel") alert.mock.calls[0]![2][0].onPress();
    else if (outcome === "dismiss") alert.mock.calls[0]![3].onDismiss();
    else if (outcome === "success" || outcome === "failure") {
      if (outcome === "failure") rpc.mockRejectedValueOnce(new Error("offline"));
      alert.mock.calls[0]![2][1].onPress();
    }
    await vi.waitFor(() => expect(finished).toHaveBeenCalledOnce());
  },
);

it("pins default preview and deletion to the initial Space despite selection changes", async () => {
  const context = { apiBase: "https://example.test", headers: { "x-rakazo-space-id": "space-a" } };
  captureApiRequestContext.mockResolvedValueOnce(context);
  let finish!: (groups: unknown[]) => void;
  rpc.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = confirmDeleteBot({ id: "fixture", name: "Fixture" }, vi.fn());
  await vi.waitFor(() => expect(rpc).toHaveBeenCalledOnce());
  captureApiRequestContext.mockResolvedValue({
    ...context,
    headers: { "x-rakazo-space-id": "space-b" },
  });
  finish([]);
  await pending;
  alert.mock.calls[0]![2][1].onPress();
  await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
  expect(captureApiRequestContext).toHaveBeenCalledOnce();
  expect(rpc.mock.calls.every((call) => call[2]?.requestContext === context)).toBe(true);
});

it("does not offer deletion when initial context capture fails", async () => {
  captureApiRequestContext.mockRejectedValueOnce(new Error("session changed"));
  const finished = vi.fn();
  await confirmDeleteBot(
    { id: "fixture", name: "Fixture" },
    vi.fn(),
    () => true,
    undefined,
    finished,
  );
  expect(rpc).not.toHaveBeenCalled();
  expect(finished).toHaveBeenCalledOnce();
  expect(alert.mock.calls.some((call) => call[0] === "Delete Fixture?")).toBe(false);
});

it.each(["failed", "changed"] as const)(
  "reports actual removed groups when the preview %s",
  async (preview) => {
    const deleted = vi.fn();
    if (preview === "failed") rpc.mockRejectedValueOnce(new Error("offline"));
    else rpc.mockResolvedValueOnce([{ id: "retained-group", name: "Retained" }]);
    rpc.mockResolvedValueOnce({ ok: true, removedGroupIds: ["actually-removed"] });
    await confirmDeleteBot({ id: "fixture", name: "Fixture" }, deleted);
    alert.mock.calls[0]![2][1].onPress();
    await vi.waitFor(() => expect(deleted).toHaveBeenCalledWith(["actually-removed"]));
  },
);

it("does not treat an old server's preview as a deletion result", async () => {
  const deleted = vi.fn();
  rpc.mockResolvedValueOnce([{ id: "preview-group", name: "Preview" }]);
  rpc.mockResolvedValueOnce({ ok: true });
  await confirmDeleteBot({ id: "fixture", name: "Fixture" }, deleted);
  alert.mock.calls[0]![2][1].onPress();
  await vi.waitFor(() => expect(deleted).toHaveBeenCalledWith([]));
});

it("does not open deletion confirmation for a replaced session", async () => {
  captureApiRequestContext.mockResolvedValue({
    apiBase: "https://example.test",
    headers: {},
    sessionGeneration: 1,
  });
  const finished = vi.fn();
  await confirmDeleteBot(
    { id: "bot-fixture", name: "Fixture" },
    vi.fn(),
    () => true,
    undefined,
    finished,
  );
  expect(alert).not.toHaveBeenCalled();
  expect(finished).toHaveBeenCalledOnce();
});

it("does not update a replacement session after deletion completes", async () => {
  captureApiRequestContext.mockResolvedValue({
    apiBase: "https://example.test",
    headers: {},
    sessionGeneration: 2,
  });
  let resolve!: (value: unknown) => void;
  rpc.mockResolvedValueOnce([]).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const deleted = vi.fn();
  await confirmDeleteBot({ id: "bot-fixture", name: "Fixture" }, deleted);
  alert.mock.calls[0]![2][1].onPress();
  session.generation = 3;
  resolve({ ok: true, removedGroupIds: [] });
  await Promise.resolve();
  expect(deleted).not.toHaveBeenCalled();
  expect(removeFromSearchInbox).not.toHaveBeenCalled();
});
