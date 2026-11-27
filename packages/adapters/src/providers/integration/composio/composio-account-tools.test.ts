import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { composioAccountTools } from "./composio-account-tools.js";

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
