import { afterEach, expect, it, vi } from "vitest";
import { ApplicationCredentialError, loadConfiguredApps } from "./configured-apps.js";
import { creativeFixture, musicInput } from "./creative.test-support.js";
import { CreativeServiceError } from "./creative-provider.js";
import { ConnectorRegistry } from "./integrations/connector-registry.js";

afterEach(() => vi.unstubAllGlobals());
it("loads creative logic only on the application host and uses its credential boundary", async () => {
  const f = creativeFixture();
  vi.stubGlobal("fetch", f.fetcher);
  const apps = await loadConfiguredApps({
    ...f.deps,
    credentials: async (userId) => f.identities.get(userId) ?? null,
    env: { APP_CONNECTIONS: JSON.stringify({ creative: f.config }) },
  });
  try {
    const registry = new ConnectorRegistry(apps.connectors);
    expect(await registry.managed("creative")!.catalog(f.context())).toMatchObject([
      { connected: true },
    ]);
    expect(f.deps.providerScopeKey).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-a", spaceId: "space-a" }),
      "creative",
      "creative",
    );
    expect(f.db.$executeRaw).toHaveBeenCalledWith(
      expect.anything(),
      "synthetic-shared-connection-scope",
    );
    const context = f.context();
    const tool = (await registry.discoverTools(context)).find(
      (tool) => tool.route?.toolName === "creative_submit",
    )!;
    const events = [];
    for await (const event of registry.execute(
      { tool: tool.name, route: tool.route, args: musicInput, executionId: "execution-a" },
      context,
    ))
      events.push(event);
    expect(events).toMatchObject([{ type: "result", data: { status: "queued" } }]);
    expect(f.putCount()).toBe(1);
    expect(f.effects).toHaveLength(1);
    expect(f.effects[0]!.request).toMatchObject({ userId: "user-a", input: musicInput });
  } finally {
    await apps.stop();
  }
});

it("keeps authentication error semantics at the adapter boundary", async () => {
  const f = creativeFixture();
  const apps = await loadConfiguredApps({
    ...f.deps,
    credentials: async () => {
      throw new ApplicationCredentialError("authentication_unavailable", 503);
    },
    env: { APP_CONNECTIONS: JSON.stringify({ creative: f.config }) },
  });
  try {
    const connector = new ConnectorRegistry(apps.connectors).managed("creative")!;
    await expect(
      connector.begin(
        { provider: "creative", redirectUrl: "https://bot.example.test" },
        f.context(),
      ),
    ).rejects.toBeInstanceOf(CreativeServiceError);
  } finally {
    await apps.stop();
  }
});
