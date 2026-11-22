import { deferred, flush } from "@rakazo/core/test-async";
import { expect, it, vi } from "vitest";

const { rpc, loaded } = vi.hoisted(() => ({
  rpc: vi.fn(),
  loaded: { promise: Promise.resolve() },
}));
vi.mock("../api/api", () => ({ rpc }));
vi.mock("../api/api-server", () => ({ apiBaseLoaded: () => loaded.promise }));

import { finishReturnedAppConnection } from "./app-connect-return";

it("waits for launch to restore the server and Space before finishing a sign-in", async () => {
  const launch = deferred<void>();
  loaded.promise = launch.promise;
  rpc.mockResolvedValue({ status: "connected" });

  finishReturnedAppConnection("rakazo://app-connect?connection=connection-1");
  await flush();
  expect(rpc).not.toHaveBeenCalled();

  launch.resolve();
  await vi.waitFor(() =>
    expect(rpc).toHaveBeenCalledWith("connections/complete", { connectionId: "connection-1" }),
  );
});
