import { deferred } from "@rakazo/core/test-async";
import { describe, expect, it, vi } from "vitest";
import { sharedInflight } from "./shared-inflight.js";

describe("sharedInflight", () => {
  it("reuses one in-flight promise when a second caller arrives before the first resolves", async () => {
    const inflight = new Map<string, Promise<string>>();
    const resolveProvision = deferred<string>();
    const start = vi.fn(() => resolveProvision.promise);

    const first = sharedInflight(inflight, "bot-1", start);
    const second = sharedInflight(inflight, "bot-1", start);

    expect(start).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);

    resolveProvision.resolve("secret-a");
    await expect(Promise.all([first, second])).resolves.toEqual(["secret-a", "secret-a"]);
    expect(inflight.has("bot-1")).toBe(false);

    const third = sharedInflight(inflight, "bot-1", async () => "secret-b");
    await expect(third).resolves.toBe("secret-b");
    expect(start).toHaveBeenCalledTimes(1);
  });
});
