import { expect, it, vi } from "vitest";
import { rpc } from "../query/rpc";
import { waitForModelOAuth } from "./model-auth";

vi.mock("../query/rpc", () => ({
  rpc: { models: { completeOAuth: vi.fn() } },
}));

it("sends the sign-in ID and cancellation signal on the client that began it", async () => {
  const signal = new AbortController().signal;
  const completeOAuth = vi.fn().mockResolvedValue({ status: "ready" });
  const client = { models: { completeOAuth } } as unknown as Parameters<
    typeof waitForModelOAuth
  >[2];

  await waitForModelOAuth({ loginId: "login-id", expiresInSeconds: 900 }, signal, client);

  expect(completeOAuth).toHaveBeenCalledExactlyOnceWith({ loginId: "login-id" }, { signal });
  expect(rpc.models.completeOAuth).not.toHaveBeenCalled();
});
