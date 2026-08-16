import { beforeEach, describe, expect, it, vi } from "vitest";
import { rpc } from "./api";
import { waitForModelOAuth } from "./model-auth";

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

  it("returns a connected credential normally", async () => {
    mockRpc.mockResolvedValue({
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
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });
});
