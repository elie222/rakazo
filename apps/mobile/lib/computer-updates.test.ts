import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ rpc: vi.fn(), follow: vi.fn(), seq: 0 }));
vi.mock("./api-server", () => ({}));
vi.mock("./api-auth", () => ({}));
vi.mock("./api-live", () => ({ subscribeComputerUpdateSignals: api.follow }));
vi.mock("./api", () => ({
  rpc: api.rpc,
  spaceSelectionSeq: () => api.seq,
  subscribeSpaceSelection: () => () => {},
}));

import { computerUpdates } from "./computer-updates";

const unauthorized = () => Object.assign(new Error("Unauthorized"), { status: 401 });
const notFound = () => Object.assign(new Error("Not found"), { status: 404 });

beforeEach(() => {
  // A server without change signals, so the list is polled.
  api.follow.mockRejectedValue(notFound());
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  api.rpc.mockReset();
  api.follow.mockReset();
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

  it("reopens the change stream after a 401 sent before a Space switch", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    api.rpc.mockResolvedValue([]);
    api.follow.mockImplementationOnce(async () => {
      api.seq += 1;
      throw unauthorized();
    });
    api.follow.mockImplementationOnce(() => new Promise(() => {}));
    const stop = computerUpdates.watch();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(api.follow).toHaveBeenCalledTimes(2);
    stop();
  });
});
