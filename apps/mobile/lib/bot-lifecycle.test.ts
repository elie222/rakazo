import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc, alert } = vi.hoisted(() => ({ rpc: vi.fn(), alert: vi.fn() }));
vi.mock("./api", () => ({ rpc }));
vi.mock("react-native", () => ({ Alert: { alert } }));
vi.mock("./i18n", () => ({ t: (message: string) => message }));
vi.mock("./user-error", () => ({ errorText: () => "Try again." }));

import { confirmDeleteBot, restoreArchivedBot } from "./bot-lifecycle";

beforeEach(() => vi.clearAllMocks());
describe("archived bot lifecycle", () => {
  it("waits for restore and propagates failure instead of opening a writable chat", async () => {
    rpc.mockResolvedValueOnce({ ok: true });
    await restoreArchivedBot("bot-fixture");
    expect(rpc).toHaveBeenCalledWith("bots/restore", { botId: "bot-fixture" });
    rpc.mockRejectedValueOnce(new Error("offline"));
    await expect(restoreArchivedBot("bot-fixture")).rejects.toThrow("offline");
  });
  it("cancel never removes a bot, and both deletion choices are destructive", () => {
    confirmDeleteBot({ id: "bot-fixture", name: "Fixture" }, vi.fn());
    expect(rpc).not.toHaveBeenCalled();
    const buttons = alert.mock.calls[0]![2];
    expect(buttons.map((button: { style: string }) => button.style)).toEqual([
      "cancel",
      "destructive",
      "destructive",
    ]);
  });
  it("removes the row only after the selected deletion succeeds", async () => {
    const deleted = vi.fn();
    rpc.mockResolvedValueOnce({ ok: true });
    confirmDeleteBot({ id: "bot-fixture", name: "Fixture" }, deleted);
    await alert.mock.calls[0]![2][1].onPress();
    await Promise.resolve();
    expect(rpc).toHaveBeenCalledWith("bots/remove", {
      botId: "bot-fixture",
      deleteMemories: false,
    });
    expect(deleted).toHaveBeenCalledOnce();
  });
});
