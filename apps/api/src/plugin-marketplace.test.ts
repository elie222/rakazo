import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor: Actor = {
  spaceId: "space-fixture",
  userId: "user-fixture",
  email: "fixture@example.test",
  isDeploymentOwner: false,
};
function setup() {
  const read = vi.fn(async (url: string) => {
    if (url.includes("/git/trees/"))
      return JSON.stringify({ tree: [{ path: "notes/skills/plan/SKILL.md", type: "blob" }] });
    if (url.endsWith("plugin-index.json"))
      return JSON.stringify({ plugins: { notes: { components: { skills: [{}] } } } });
    if (url.endsWith("marketplace.json"))
      return JSON.stringify({ plugins: [{ name: "notes", source: "notes" }] });
    throw new Error("Not found");
  });
  const router = createRouter({
    prisma: {} as never,
    pluginMarketplaceRead: read,
    env: { webOrigin: "http://localhost:5173", defaultProvider: "fake", defaultModel: "fake" },
    dataDir: "/tmp/marketplace-rpc-test",
  } as unknown as RouterDeps);
  return {
    read,
    client: (current: Actor | null) => createRouterClient(router, { context: { actor: current } }),
  };
}
describe("marketplace RPC", () => {
  it("requires authentication before reading remote indexes", async () => {
    const { read, client } = setup();
    await expect(client(null).marketplace.catalog({ query: "" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(read).not.toHaveBeenCalled();
  });
  it("uses the bounded server catalog rather than a browser fetch", async () => {
    const { read, client } = setup();
    const result = await client(actor).marketplace.catalog({ query: "notes" });
    expect(result.entries).toHaveLength(2);
    expect(result.entries.map((row) => row.registry)).toEqual(["Cursor", "xAI"]);
    const reads = read.mock.calls.length;
    expect((await client(actor).marketplace.catalog({ query: "missing" })).entries).toEqual([]);
    expect(read).toHaveBeenCalledTimes(reads);
  });
});
