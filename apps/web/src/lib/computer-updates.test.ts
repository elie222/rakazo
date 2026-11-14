// @vitest-environment jsdom
import type { ComputerUpdate } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

const space = vi.hoisted(() => ({ id: "space-1" as string | null }));
const updates = vi.hoisted(() => vi.fn());
vi.mock("./rpc", () => ({
  rpc: { computer: { updates } },
  SPACE_SELECTED_EVENT: "test:space-selected",
  selectedSpaceId: () => space.id,
}));

import { computerUpdates } from "./computer-updates";

const update: ComputerUpdate = {
  id: "update-1",
  botId: "bot-1",
  name: "Writer",
  mode: "team",
  action: "update",
  status: "failed",
  stage: "saving",
};

afterEach(() => {
  vi.useRealTimers();
  updates.mockReset();
  space.id = "space-1";
});

describe("web computer updates", () => {
  it("starts over only when another Space is selected", async () => {
    vi.useFakeTimers();
    updates.mockResolvedValue([update]);
    const stop = computerUpdates.watch();
    computerUpdates.signalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(computerUpdates.getSnapshot().updates).toEqual([update]);
    const calls = updates.mock.calls.length;

    window.dispatchEvent(new Event("test:space-selected"));
    expect(computerUpdates.getSnapshot().updates).toEqual([update]);
    await vi.advanceTimersByTimeAsync(0);
    expect(updates).toHaveBeenCalledTimes(calls);

    space.id = "space-2";
    updates.mockResolvedValue([]);
    window.dispatchEvent(new Event("test:space-selected"));
    expect(computerUpdates.getSnapshot().updates).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(updates).toHaveBeenCalledTimes(calls + 1);
    stop();
  });
});
