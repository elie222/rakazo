import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./rpc", () => ({ rpc: { bootstrap: vi.fn() } }));
vi.mock("./performance", () => ({ markOnce: vi.fn() }));

import { rpc } from "./rpc";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("bootstrap upload configuration", () => {
  it.each([undefined, 2 * 1024 * 1024, 25 * 1024 * 1024])(
    "uses the server limit %s with an older-server fallback",
    async (maxUploadSizeBytes) => {
      vi.stubGlobal("window", { location: { pathname: "/sign-in" } });
      vi.mocked(rpc.bootstrap).mockResolvedValue({
        me: { ticketBoardEnabled: false, maxUploadSizeBytes },
      } as Awaited<ReturnType<typeof rpc.bootstrap>>);
      const { takeInitialBootstrap, getMaxUploadSizeBytes } = await import("./bootstrap");
      await takeInitialBootstrap();
      expect(getMaxUploadSizeBytes()).toBe(maxUploadSizeBytes ?? 10 * 1024 * 1024);
    },
  );
});
