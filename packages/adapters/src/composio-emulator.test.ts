import { describe, expect, it } from "vitest";
import { createConnectorStack } from "./composio-connector.js";
import { ComposioEmulator } from "./composio-emulator.js";

const context = {
  operationId: "test",
  traceId: "test",
  workspaceId: "workspace",
  userId: "user-1",
  signal: new AbortController().signal,
};

describe("ComposioEmulator", () => {
  it("remains registered when explicitly supplied without a live Composio key", () => {
    const emulator = new ComposioEmulator();
    const stack = createConnectorStack(false, emulator);

    expect(stack.connector.managed("composio")).toBe(emulator);
  });

  it("serves and searches a deterministic catalog", async () => {
    const emulator = new ComposioEmulator();

    await expect(emulator.catalog(context)).resolves.toHaveLength(6);
    await expect(emulator.catalog(context, "git")).resolves.toEqual([
      expect.objectContaining({ slug: "GITHUB", name: "GitHub", connected: false }),
    ]);
  });

  it("isolates connection state by user and supports revoke", async () => {
    const emulator = new ComposioEmulator();
    await emulator.begin({ provider: "GMAIL", redirectUrl: "http://example.test" }, context);

    await expect(emulator.connectionReady(context, "GMAIL")).resolves.toBe(true);
    await expect(emulator.listConnectedSlugs(context.userId)).resolves.toEqual(["GMAIL"]);
    await expect(emulator.connectionReady({ ...context, userId: "user-2" }, "GMAIL")).resolves.toBe(
      false,
    );
    await expect(emulator.catalog(context, "gmail")).resolves.toEqual([
      expect.objectContaining({ slug: "GMAIL", connected: true }),
    ]);

    await emulator.revoke("GMAIL", context);
    await expect(emulator.connectionReady(context, "GMAIL")).resolves.toBe(false);
  });

  it("discovers and executes deterministic tools for connected apps", async () => {
    const emulator = new ComposioEmulator();
    const connectedContext = {
      ...context,
      connectedConnections: [
        {
          id: "connection-gmail",
          connectorId: "composio",
          externalId: "GMAIL",
          displayName: "Gmail",
        },
      ],
    };
    await expect(emulator.discoverTools(connectedContext)).resolves.toContainEqual(
      expect.objectContaining({ name: "GMAIL_EMULATED_ACTION" }),
    );
    const events = [];
    for await (const event of emulator.execute(
      {
        tool: "GMAIL_EMULATED_ACTION",
        args: { value: "ok" },
        executionId: "composio-emulator-execution",
      },
      connectedContext,
    )) {
      events.push(event);
    }
    expect(events).toContainEqual(expect.objectContaining({ type: "result" }));
    expect(emulator.executions).toEqual([
      {
        userId: context.userId,
        tool: "GMAIL_EMULATED_ACTION",
        args: { value: "ok" },
      },
    ]);
  });
});
