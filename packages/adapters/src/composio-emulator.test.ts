import { describe, expect, it } from "vitest";
import { createConnectorStack } from "./composio-connector.js";
import { ComposioEmulator } from "./composio-emulator.js";

const context = {
  operationId: "test",
  traceId: "test",
  spaceId: "workspace",
  userId: "user-1",
  botId: "bot-1",
  runId: "run-1",
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
        botId: context.botId,
        runId: context.runId,
        tool: "GMAIL_EMULATED_ACTION",
        args: { value: "ok" },
        result: { ok: true, tool: "GMAIL_EMULATED_ACTION", args: { value: "ok" } },
      },
    ]);
  });

  it("exposes seeded GitHub release tools without live OAuth", async () => {
    const emulator = new ComposioEmulator();
    const connectedContext = {
      ...context,
      connectedConnections: [
        {
          id: "connection-github",
          connectorId: "composio",
          externalId: "GITHUB",
          displayName: "GitHub",
        },
      ],
    };

    const tools = await emulator.discoverTools(connectedContext);
    expect(tools.map((tool) => tool.name)).toEqual(["GITHUB_LIST_RELEASES", "GITHUB_GET_RELEASE"]);
    expect(tools.map((tool) => tool.name)).not.toContain("GITHUB_EMULATED_ACTION");

    const events = [];
    for await (const event of emulator.execute(
      {
        tool: "GITHUB_LIST_RELEASES",
        args: { owner: "elie222", repo: "rakazo" },
        executionId: "github-list-releases",
      },
      connectedContext,
    )) {
      events.push(event);
    }
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "result",
        data: expect.objectContaining({
          ok: true,
          releases: expect.arrayContaining([
            expect.objectContaining({ tag: "v0.4.2" }),
            expect.objectContaining({ tag: "v0.4.1" }),
          ]),
        }),
      }),
    );
    expect(emulator.listGithubReleases()[0]?.tag).toBe("v0.4.2");
  });
});
