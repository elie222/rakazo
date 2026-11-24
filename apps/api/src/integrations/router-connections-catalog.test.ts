import { createRouterClient } from "@orpc/server";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import { createRouter } from "../router-test-support.js";

const twoApps = async () =>
  ["Slack", "Notion"].map((name) => ({
    connectorId: "apps",
    slug: name.toLowerCase(),
    name,
    logo: null,
    connected: false,
    noAuth: false,
  }));

function catalogClient(
  messaging: RouterDeps["messaging"],
  catalog: () => Promise<unknown> = twoApps,
) {
  const provider = { describe: () => ({ id: "apps" }), catalog };
  return createRouterClient(
    createRouter({
      prisma: {} as PrismaClient,
      connectors: { managed: () => provider },
      messaging,
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
    } as unknown as RouterDeps),
    {
      context: {
        actor: {
          spaceId: "workspace-1",
          userId: "user-1",
          email: "user@rakazo.test",
          isDeploymentOwner: true,
        },
      } as never,
    },
  );
}

describe("connections.catalog", () => {
  it("marks an app that is also a chat app this deployment offers", async () => {
    const client = catalogClient({
      enabled: true,
      providers: ["slack"],
      addresses: {},
      openSignup: false,
    });

    const catalog = await client.connections.catalog({ connectorId: "apps" });

    expect(catalog.map((item) => [item.slug, item.chatApp])).toEqual([
      ["slack", true],
      ["notion", undefined],
    ]);
  });

  it("marks nothing on a deployment without chat apps", async () => {
    const catalog = await catalogClient(undefined).connections.catalog({ connectorId: "apps" });

    expect(catalog.some((item) => item.chatApp)).toBe(false);
  });

  it("logs why a provider's catalog failed instead of hiding it", async () => {
    const warn = vi.spyOn(getLogger(), "warn").mockImplementation(() => {});
    const client = catalogClient(undefined, async () => {
      throw new Error("401 Invalid API key ak_fakekey123456789");
    });

    expect(await client.connections.catalog({ connectorId: "apps" })).toEqual([]);
    expect(warn).toHaveBeenCalledWith("apps catalog could not be loaded", {
      error: expect.not.stringContaining("ak_fakekey123456789"),
    });
  });
});
