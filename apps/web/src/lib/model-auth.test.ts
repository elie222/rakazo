import { beforeEach, describe, expect, it, vi } from "vitest";
import { waitForModelOAuth } from "./model-auth";
import { rpc } from "./rpc";

vi.mock("./rpc", () => ({
  rpc: { models: { completeOAuth: vi.fn() } },
}));

describe("waitForModelOAuth", () => {
  const completeOAuth = vi.mocked(rpc.models.completeOAuth);

  beforeEach(() => {
    completeOAuth.mockReset();
  });

  it("stops polling when its signal is aborted", async () => {
    completeOAuth.mockResolvedValue({ status: "pending" });
    const controller = new AbortController();
    const polling = waitForModelOAuth("login-id", controller.signal);

    await Promise.resolve();
    expect(completeOAuth).toHaveBeenCalledTimes(1);
    controller.abort();

    await expect(polling).rejects.toBeDefined();
    expect(completeOAuth).toHaveBeenCalledTimes(1);
  });

  it("returns a connected credential without waiting for another poll", async () => {
    completeOAuth.mockResolvedValue({
      status: "connected",
      credential: {
        id: "credential-id",
        provider: "provider",
        label: "Provider",
        hasKey: true,
        isDefault: true,
      },
    });

    await expect(waitForModelOAuth("login-id")).resolves.toMatchObject({ status: "connected" });
    expect(completeOAuth).toHaveBeenCalledTimes(1);
  });
});
