import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { composioAccountTools } from "./composio-account-tools.js";
import { ComposioConnector } from "./composio-connector.js";
import { FakeComposioClient } from "./composio-fake.js";

describe("shared account tools", () => {
  it("discovers slug-scoped tools during a directory outage without executing unpinned", async () => {
    const context: AdapterContext = {
      operationId: "discover",
      traceId: "discover",
      userId: "user",
      spaceId: "space",
      signal: new AbortController().signal,
      connectedConnections: [
        {
          id: "connection",
          connectorId: "composio",
          organizationId: "team",
          externalId: "example",
          providerRef: "example",
          displayName: "Example",
        },
      ],
    };
    const sessionFor = vi.fn();
    const accountTools = composioAccountTools(
      async () => [
        { name: "list_items", description: "List items", inputSchema: { type: "object" } },
      ],
      sessionFor,
      async () => undefined,
    );
    const [tool] = await accountTools.discoverTools(context);
    expect(tool?.route?.connectionId).toBe("connection");
    const result = await accountTools
      .execute(
        {
          tool: tool!.name,
          route: tool!.route,
          args: {},
          executionId: "call",
        },
        context,
      )
      [Symbol.asyncIterator]()
      .next();
    expect(result.value).toMatchObject({ type: "error" });
    expect(sessionFor).not.toHaveBeenCalled();
  });
});

it("executes a scoped Drive route using the selected personal account", async () => {
  const client = new FakeComposioClient();
  const userId = "user";
  const selected = client.connect(userId, "googledrive");
  const sibling = client.connect(userId, "googledrive");
  const connector = new ComposioConnector({ client });
  const context: AdapterContext = {
    operationId: "scoped-drive",
    traceId: "scoped-drive",
    userId,
    spaceId: "space",
    signal: new AbortController().signal,
    connectedConnections: [selected, sibling].map((ref) => ({
      id: `connection-${ref}`,
      connectorId: "composio",
      externalId: "googledrive",
      providerRef: ref,
      displayName: "Drive",
    })),
  };
  const tools = await connector.discoverTools(context);
  const tool = tools.find(({ route }) => route?.connectionId === `connection-${selected}`)!;
  const events = [];
  for await (const event of connector.execute(
    { tool: tool.name, route: tool.route, args: {}, executionId: "scoped-drive" },
    context,
  )) {
    events.push(event);
  }
  expect(events).toEqual([expect.objectContaining({ type: "result" })]);
  expect(client.created.at(-1)).toMatchObject({
    userId,
    config: { connectedAccounts: { GOOGLEDRIVE: [selected] } },
  });
});
