import { beforeEach, describe, expect, it, vi } from "vitest";
import { rpc } from "./api";
import { cancelModelOAuthAttempt, finishModelOAuthAttempt, waitForModelOAuth } from "./model-auth";

vi.mock("./api", () => ({ rpc: vi.fn() }));

describe("mobile waitForModelOAuth", () => {
  const mockRpc = vi.mocked(rpc);

  beforeEach(() => {
    mockRpc.mockReset();
  });

  it("stops polling when its screen loses focus", async () => {
    mockRpc.mockResolvedValue({ status: "pending" });
    const controller = new AbortController();
    const polling = waitForModelOAuth("login-id", controller.signal);

    await Promise.resolve();
    expect(mockRpc).toHaveBeenCalledTimes(1);
    controller.abort();

    await expect(polling).rejects.toBeDefined();
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it("returns readiness normally", async () => {
    mockRpc.mockResolvedValue({ status: "ready" });

    await expect(waitForModelOAuth("login-id")).resolves.toMatchObject({ status: "ready" });
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });
});

describe("mobile OAuth focus lifecycle", () => {
  it("resets busy state on focus cleanup and protects a newer attempt", () => {
    const ref = { current: null as AbortController | null };
    let busy = false;
    const reset = () => {
      busy = false;
    };
    const startAttempt = () => {
      const controller = new AbortController();
      ref.current = controller;
      busy = true;
      return controller;
    };

    const first = startAttempt();
    cancelModelOAuthAttempt(ref, reset);

    expect(first.signal.aborted).toBe(true);
    expect(ref.current).toBeNull();
    expect(busy).toBe(false);

    const second = startAttempt();
    finishModelOAuthAttempt(ref, first, reset);

    expect(ref.current).toBe(second);
    expect(busy).toBe(true);

    finishModelOAuthAttempt(ref, second, reset);
    expect(ref.current).toBeNull();
    expect(busy).toBe(false);
  });
});
