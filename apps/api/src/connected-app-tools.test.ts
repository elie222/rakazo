import { createRouterClient } from "@orpc/server";
import type { ConnectorTool } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { expect, it, vi } from "vitest";
import { creativeFixture } from "../../../packages/adapters/src/creative.test-support.js";
import { ConnectorRegistry } from "../../../packages/adapters/src/integrations/connector-registry.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor: Actor = {
  userId: "user-a",
  spaceId: "space-a",
  email: "demo@example.test",
  isDeploymentOwner: false,
};

function fixture(tools: ConnectorTool[], connected = true) {
  const discoverTools = vi.fn(async () => tools);
  const findFirst = vi.fn(async () =>
    connected ? { id: "connection-a", displayName: "Example", providerRef: "binding-a" } : null,
  );
  const deps = {
    prisma: { connection: { findFirst } },
    connectors: { managed: () => ({ discoverTools }) },
    env: { webOrigin: "https://example.test" },
  } as unknown as RouterDeps;
  const client = createRouterClient(createRouter(deps), { context: { actor } as never });
  return { client, discoverTools, findFirst };
}

it("displays app-defined names through the unchanged list API and preserves every run's identities", async () => {
  const f = creativeFixture();
  await f.connect();
  const before = await f.connector.discoverTools(f.context());
  const client = createRouterClient(
    createRouter({
      ...f.deps,
      connectors: new ConnectorRegistry([f.connector]),
      env: { webOrigin: "https://example.test" },
    } as unknown as RouterDeps),
    { context: { actor } as never },
  );
  const displayed = await client.connections.tools({
    connectorId: "creative",
    provider: "creative",
  });
  expect(displayed.map((tool) => tool.name)).toEqual([
    "View models",
    "Create media",
    "Check progress",
  ]);
  for (const context of [f.context(), { ...f.context(), operationId: "connections.tools" }]) {
    const runtime = await f.connector.discoverTools(context);
    expect(runtime.map((tool) => tool.name)).toEqual(before.map((tool) => tool.name));
    expect(runtime.map((tool) => tool.route)).toEqual(before.map((tool) => tool.route));
    expect(runtime.map((tool) => tool.readOnly)).toEqual([true, false, true]);
  }
  expect(f.putCount()).toBe(0);
});

it("preserves existing names for other adapters", async () => {
  const tool = { name: "example_action__1234567890abcdef", description: "Read", inputSchema: {} };
  const f = fixture([tool]);
  expect(await f.client.connections.tools({ connectorId: "example", provider: "example" })).toEqual(
    [{ name: tool.name, description: tool.description }],
  );
});

it("does not discover or expose tool titles without the person's connected account", async () => {
  const f = fixture([], false);
  expect(await f.client.connections.tools({ connectorId: "example", provider: "example" })).toEqual(
    [],
  );
  expect(f.discoverTools).not.toHaveBeenCalled();
});
