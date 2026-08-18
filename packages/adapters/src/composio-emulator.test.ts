import { describe, expect, it } from "vitest";
import { ComposioEmulator } from "./composio-emulator.js";

const context = {
  operationId: "test",
  traceId: "test",
  workspaceId: "workspace",
  userId: "user-1",
  signal: new AbortController().signal,
};

describe("ComposioEmulator", () => {
  it("serves and searches a deterministic catalog", async () => {
    const emulator = new ComposioEmulator();

    await expect(emulator.catalog(context.userId)).resolves.toHaveLength(4);
    await expect(emulator.catalog(context.userId, "git")).resolves.toEqual([
      expect.objectContaining({ slug: "GITHUB", name: "GitHub", connected: false }),
    ]);
  });

  it("isolates connection state by user and supports revoke", async () => {
    const emulator = new ComposioEmulator();
    await emulator.begin({ provider: "GMAIL", redirectUrl: "http://example.test" }, context);

    await expect(emulator.connectionReady(context.userId, "GMAIL")).resolves.toBe(true);
    await expect(emulator.connectionReady("user-2", "GMAIL")).resolves.toBe(false);
    await expect(emulator.catalog(context.userId, "gmail")).resolves.toEqual([
      expect.objectContaining({ slug: "GMAIL", connected: true }),
    ]);

    await emulator.revoke("GMAIL", context);
    await expect(emulator.connectionReady(context.userId, "GMAIL")).resolves.toBe(false);
  });
});
