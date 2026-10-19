import { createRouterClient } from "@orpc/server";
import type { SecretStore } from "@rakazo/adapter-kit";
import { BUILTIN_AGENT_SKILLS, previewPluginInstall } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { installPlugin } from "./plugin-installs.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor: Actor = {
  spaceId: "space-test",
  userId: "user-test",
  email: "user@example.test",
  isDeploymentOwner: false,
};
const source = "https://github.com/example/plugin";
const sha = "a".repeat(40);
const fetcher = async () => ({
  resolvedSha: sha,
  files: [
    { path: ".grok-plugin/plugin.json", content: JSON.stringify({ name: "example-plugin" }) },
    {
      path: "skills/example/SKILL.md",
      content: "---\nname: example-skill\ndescription: Example skill\n---\n\nUse the tools.\n",
    },
    {
      path: ".mcp.json",
      content: JSON.stringify({
        mcpServers: {
          remote: {
            type: "http",
            url: "https://tools.example.test/mcp",
            headers: { "X-Tenant": "package-tenant" },
          },
        },
      }),
    },
  ],
});
function setup() {
  const prisma = {
    $executeRaw: vi.fn(),
    capabilityInstall: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(async ({ data }) => ({ ...data, id: "install-test", createdAt: new Date(0) })),
    },
    agentSkill: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() },
    mcpServer: { create: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    secret: { create: vi.fn(), count: vi.fn().mockResolvedValue(1) },
    botSecret: { count: vi.fn().mockResolvedValue(0) },
    integrationProviderConfig: { count: vi.fn().mockResolvedValue(0) },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (run) => run(prisma));
  const secrets = {
    put: vi.fn().mockResolvedValue({ id: "secret-test", ciphertext: "encrypted-header-material" }),
    delete: vi.fn().mockResolvedValue(undefined),
  } as unknown as SecretStore;
  return {
    prisma,
    secrets,
    deps: {
      prisma: prisma as never,
      secrets,
      fetcher,
      assertEndpoint: vi.fn().mockResolvedValue(undefined),
    },
  };
}
async function input() {
  return {
    source,
    name: "Example",
    config: {},
    pluginDigest: (await previewPluginInstall({ source, fetcher })).digest,
  };
}

describe("confirmed plugin installation", () => {
  it("persists read-only skills and native MCP rows atomically, not credentials in config", async () => {
    const { deps, prisma, secrets } = setup();
    const result = await installPlugin(deps, actor, await input());
    expect(result).toMatchObject({ kind: "plugin", version: sha });
    expect(JSON.stringify(result)).not.toContain("package-tenant");
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.agentSkill.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        spaceId: actor.spaceId,
        userId: actor.userId,
        source: "plugin",
        installId: "install-test",
        name: "example-skill",
      }),
    });
    expect(secrets.put).toHaveBeenCalledWith(
      JSON.stringify({ env: {}, headers: { "X-Tenant": "package-tenant" } }),
      expect.objectContaining({ userId: actor.userId }),
    );
    expect(prisma.mcpServer.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        installId: "install-test",
        secretId: "secret-test",
        headers: { "X-Tenant": true },
        transport: "streamable_http",
      }),
    });
    expect(deps.assertEndpoint).toHaveBeenCalledWith("https://tools.example.test/mcp");
  });
  it("does not write anything without confirmation or after changed content", async () => {
    const { deps, prisma } = setup();
    const args = await input();
    await expect(
      installPlugin(deps, actor, { ...args, pluginDigest: undefined }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      installPlugin(deps, actor, { ...args, pluginDigest: `sha256:${"0".repeat(64)}` }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it("refuses variables and pasted credentials rather than saving plaintext config", async () => {
    const { deps, prisma, secrets } = setup();
    const args = await input();
    await expect(
      installPlugin(deps, actor, { ...args, config: { variables: { TOKEN: "fake-token" } } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      installPlugin(deps, actor, { ...args, credential: "fake-token" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(secrets.put).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it("rejects duplicates and skill clashes without renaming or overwriting", async () => {
    const { deps, prisma } = setup();
    prisma.capabilityInstall.findFirst.mockResolvedValueOnce({ id: "existing" } as never);
    await expect(installPlugin(deps, actor, await input())).rejects.toMatchObject({
      code: "CONFLICT",
    });
    prisma.agentSkill.findFirst.mockResolvedValueOnce({ id: "existing-skill" } as never);
    await expect(installPlugin(deps, actor, await input())).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(prisma.capabilityInstall.create).not.toHaveBeenCalled();
    expect(prisma.agentSkill.create).not.toHaveBeenCalled();
  });
  it("checks built-in names before opening a write transaction", async () => {
    const { deps, prisma } = setup();
    const builtin = BUILTIN_AGENT_SKILLS[0]!;
    deps.fetcher = async () => ({
      resolvedSha: sha,
      files: [
        { path: ".cursor-plugin/plugin.json", content: JSON.stringify({ name: "example-plugin" }) },
        { path: "skills/builtin/SKILL.md", content: builtin.content },
      ],
    });
    const digest = (await previewPluginInstall({ source, fetcher: deps.fetcher })).digest;
    await expect(
      installPlugin(deps, actor, { source, name: "Example", config: {}, pluginDigest: digest }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it("cleans prepared secret references when a later encryption fails", async () => {
    const { deps, prisma, secrets } = setup();
    deps.fetcher = async () => ({
      resolvedSha: sha,
      files: [
        { path: ".grok-plugin/plugin.json", content: JSON.stringify({ name: "example-plugin" }) },
        {
          path: ".mcp.json",
          content: JSON.stringify({
            mcpServers: {
              first: {
                type: "http",
                url: "https://tools.example.test/first",
                headers: { "X-Tenant": "one" },
              },
              second: {
                type: "http",
                url: "https://tools.example.test/second",
                headers: { "X-Tenant": "two" },
              },
            },
          }),
        },
      ],
    });
    vi.mocked(secrets.put)
      .mockResolvedValueOnce({
        id: "secret-test",
        ref: "encrypted-header-material",
        ciphertext: "encrypted-header-material",
      })
      .mockRejectedValueOnce(new Error("store unavailable"));
    prisma.secret.count.mockResolvedValue(0);
    const digest = (await previewPluginInstall({ source, fetcher: deps.fetcher })).digest;
    await expect(
      installPlugin(deps, actor, { source, name: "Example", config: {}, pluginDigest: digest }),
    ).rejects.toThrow("store unavailable");
    expect(secrets.delete).toHaveBeenCalledWith("encrypted-header-material", "secret-test");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("blocks endpoints before writing", async () => {
    const { deps, prisma } = setup();
    deps.assertEndpoint.mockRejectedValueOnce(new Error("private endpoint"));
    await expect(installPlugin(deps, actor, await input())).rejects.toThrow("private endpoint");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("plugin RPC boundary", () => {
  function client(currentActor: Actor | null = actor) {
    const { deps, prisma } = setup();
    const router = createRouter({
      prisma: deps.prisma,
      secrets: deps.secrets,
      pluginRepoFetcher: deps.fetcher,
      remoteConnectors: { resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] },
      env: { webOrigin: "http://localhost:5173", defaultProvider: "fake", defaultModel: "fake" },
      dataDir: "/tmp/plugin-rpc-test",
    } as unknown as RouterDeps);
    return { rpc: createRouterClient(router, { context: { actor: currentActor } }), prisma };
  }
  it("requires authentication for preview", async () => {
    await expect(client(null).rpc.capabilities.pluginPreview({ source })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
  it("returns summaries without sensitive material and requires digest at install", async () => {
    const { rpc, prisma } = client();
    const result = await rpc.capabilities.pluginPreview({ source });
    expect(result.resolvedSha).toBe(sha);
    expect(JSON.stringify(result)).not.toContain("package-tenant");
    expect(JSON.stringify(result)).not.toContain("Use the tools");
    await expect(
      rpc.capabilities.install({ kind: "plugin", source, name: "Example", config: {} }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(prisma.capabilityInstall.create).not.toHaveBeenCalled();
  });
});
