import type {
  AdapterContext,
  ConnectorCall,
  ConnectorEvent,
  ConnectorProvider,
  ConnectorTool,
} from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { ConnectorRegistry } from "./composio-connector.js";
import { DestinationEmulator } from "./destination-emulator.js";

class StubConnector implements ConnectorProvider {
  calls: ConnectorCall[] = [];

  constructor(
    private readonly id: string,
    private readonly tools: ConnectorTool[],
  ) {}

  describe() {
    return {
      id: this.id,
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { discover: true, oauth: false, secretsBrokered: false },
    };
  }

  async discoverTools() {
    return this.tools;
  }

  async *execute(call: ConnectorCall): AsyncIterable<ConnectorEvent> {
    this.calls.push(call);
    yield { type: "result", data: { connector: this.id, tool: call.tool } };
  }
}

const context: AdapterContext = {
  operationId: "test",
  traceId: "test",
  spaceId: "workspace",
  userId: "user",
  signal: new AbortController().signal,
};

describe("ConnectorRegistry", () => {
  it("preserves every colliding tool and routes through hidden source metadata", async () => {
    const first = new StubConnector("first", [tool("shared.tool")]);
    const second = new StubConnector("second", [tool("shared.tool")]);
    const registry = new ConnectorRegistry(new DestinationEmulator(), [first, second]);

    const tools = await registry.discoverTools(context);
    const external = tools.filter((entry) => entry.route?.connectorId !== "destination");
    expect(external.map((entry) => entry.name)).toEqual(["shared.tool", "second.shared.tool"]);

    const selected = external[1]!;
    const results: unknown[] = [];
    for await (const event of registry.execute(
      {
        tool: selected.name,
        args: {},
        executionId: "execution",
        route: selected.route,
      },
      context,
    )) {
      if (event.type === "result") results.push(event.data);
    }
    expect(results).toEqual([{ connector: "second", tool: "shared.tool" }]);
    expect(first.calls).toHaveLength(0);
    expect(second.calls).toHaveLength(1);
  });
});

function tool(name: string): ConnectorTool {
  return { name, description: name, inputSchema: { type: "object", properties: {} } };
}
