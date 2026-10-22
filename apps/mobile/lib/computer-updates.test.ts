import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ rpc: vi.fn(), seq: 0 }));
vi.mock("./api", () => ({ rpc: api.rpc, spaceSelectionSeq: () => api.seq }));

import { computerUpdates } from "./computer-updates";

const unauthorized = () => Object.assign(new Error("Unauthorized"), { status: 401 });

afterEach(() => {
  vi.useRealTimers();
  api.rpc.mockReset();
  api.seq = 0;
});

describe("mobile computer updates", () => {
  it("stops polling when the current Space's session is rejected", async () => {
    vi.useFakeTimers();
    api.rpc.mockRejectedValue(unauthorized());
    const stop = computerUpdates.watch();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.rpc).toHaveBeenCalledTimes(1);
    stop();
  });

  it("keeps polling after a 401 sent before a Space switch", async () => {
    vi.useFakeTimers();
    api.rpc.mockImplementationOnce(async () => {
      api.seq += 1;
      throw unauthorized();
    });
    api.rpc.mockResolvedValue([]);
    const stop = computerUpdates.watch();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(api.rpc).toHaveBeenCalledTimes(2);
    stop();
  });
});
