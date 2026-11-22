import { afterEach, describe, expect, it, vi } from "vitest";
import { bestEffort } from "./best-effort.js";
import { installConsoleLogger } from "./console-logger.js";
import { getLogger, installLogger } from "./logger.js";

describe("installConsoleLogger", () => {
  const previous = getLogger();
  afterEach(() => {
    installLogger(previous);
    vi.restoreAllMocks();
  });

  it("writes a best-effort failure to the console as a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    installConsoleLogger("web");
    await bestEffort("refresh the roster", Promise.reject(new Error("offline")));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("best effort failed: refresh the roster");
  });

  it("leaves info out", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    installConsoleLogger("web");
    getLogger().info("opened");
    expect(info).not.toHaveBeenCalled();
  });
});
