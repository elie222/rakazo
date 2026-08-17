import { describe, expect, it, vi } from "vitest";
import { waitForModelOAuthCompletion } from "./model-oauth.js";

describe("waitForModelOAuthCompletion", () => {
  it("stops polling when its signal is aborted", async () => {
    const complete = vi.fn().mockResolvedValue({ status: "pending" as const });
    const controller = new AbortController();
    const polling = waitForModelOAuthCompletion(complete, {
      signal: controller.signal,
      pollIntervalMs: 60_000,
    });

    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(polling).rejects.toBeDefined();
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("returns readiness without another poll", async () => {
    const complete = vi.fn().mockResolvedValue({ status: "ready" as const });

    await expect(waitForModelOAuthCompletion(complete)).resolves.toEqual({
      status: "ready",
    });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("stops after the configured attempt limit", async () => {
    const complete = vi.fn().mockResolvedValue({ status: "pending" as const });

    await expect(
      waitForModelOAuthCompletion(complete, { attempts: 2, pollIntervalMs: 0 }),
    ).rejects.toThrow("timed out");
    expect(complete).toHaveBeenCalledTimes(2);
  });
});
