import { createRouterClient } from "@orpc/server";
import type { McpOAuthSummary } from "@rakazo/adapters";
import { McpOAuthClientRequiredError, McpOAuthRefusedError } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { MCP_OAUTH_CLIENT_REQUIRED } from "@rakazo/contracts";
import { flush } from "@rakazo/core/test-async";
import type { PrismaClient } from "@rakazo/db";
import { createLogger, createTestSink, getLogger, installLogger } from "@rakazo/logging";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { appHandler, createRouter, handle } from "./router-test-support.js";

describe("MCP server health", () => {
  type Row = Record<string, unknown>;
  const baseRow = (overrides: Row = {}): Row => ({
    id: "server-1",
    spaceId: "workspace-1",
    userId: "owner-1",
    slug: "gmail",
    name: "Gmail",
    description: "",
    transport: "stdio",
    endpoint: null,
    command: "npx",
    args: ["-y", "@klodr/gmail-mcp@2.0.2"],
    env: {},
    files: {},
    headers: {},
    secretId: null,
    enabled: true,
    revision: 1,
    healthStatus: "unknown",
    healthMessage: null,
    healthToolCount: null,
    healthCheckedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  });

  function harness(options: { row?: Row | null; oauth?: McpOAuthSummary; probe?: unknown } = {}) {
    let server: Row | null = options.row === undefined ? baseRow() : options.row;
    const probe = vi.fn<(...args: unknown[]) => Promise<unknown>>(
      (options.probe as (() => Promise<unknown>) | undefined) ??
        (async () => {
          await recordHealth({ healthStatus: "ok", healthToolCount: 4 });
          return { status: "ok", toolCount: 4 };
        }),
    );
    const recordHealth = async (patch: Row) => {
      if (server) server = { ...server, healthCheckedAt: new Date(5), ...patch };
    };
    const updateMany = vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      if (!matches(where)) return { count: 0 };
      await recordHealth(data);
      return { count: 1 };
    });
    const matches = (where: Row): boolean =>
      Boolean(server) &&
      Object.entries(where).every(([key, value]) =>
        key === "OR"
          ? (value as Row[]).some((branch) => matches(branch))
          : (server as Row)[key] === value,
      );
    const prisma = {
      mcpServer: {
        findMany: vi.fn(async () => []),
        findFirst: vi.fn(async ({ where }: { where: Row }) =>
          matches(where) ? { ...server } : null,
        ),
        create: vi.fn(async ({ data }: { data: Row }) => {
          server = baseRow({ ...data, id: "server-1" });
          return { ...server };
        }),
        update: vi.fn(async ({ data }: { data: Row }) => {
          const { revision: _revision, ...rest } = data;
          server = { ...server, ...rest, revision: Number(server?.revision) + 1 };
          return { ...server };
        }),
        updateMany,
      },
      mcpServerSpace: { findMany: vi.fn(async () => []) },
      secret: { findFirst: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
      user: {
        findUnique: vi.fn(async () => ({ email: "owner@rakazo.test", emailVerified: true })),
        findUniqueOrThrow: vi.fn(async () => ({
          email: "owner@rakazo.test",
          name: "Owner",
          secrets: [],
        })),
      },
      deploymentSettings: { findUnique: vi.fn().mockResolvedValue({ ownerUserId: "owner-1" }) },
      $executeRaw: vi.fn(async () => 1),
      $queryRaw: vi.fn(async () => []),
      $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(prisma)),
    } as unknown as PrismaClient;
    const summaryFor = vi.fn(
      async () => options.oauth ?? { status: "none", clientId: null, credential: true },
    );
    const deps = {
      prisma,
      secrets: { put: vi.fn(), load: vi.fn() },
      remoteConnectors: { resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] },
      mcpOAuth: { summaryFor, summaryForCiphertext: summaryFor },
      mcp: { probe },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
        mcpStdioEnabled: true,
        mcpStdioAllowedCommands: ["npx"],
        adminEmails: ["owner@rakazo.test"],
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const clientFor = (actor: Partial<Actor> = {}) =>
      createRouterClient(createRouter(deps), {
        context: {
          actor: {
            spaceId: "workspace-1",
            userId: "owner-1",
            email: "owner@rakazo.test",
            isDeploymentOwner: true,
            ...actor,
          },
        } as never,
      });
    return {
      client: clientFor(),
      clientFor,
      probe,
      updateMany,
      row: () => server,
      deps,
      createRouterWithoutProbe: () =>
        createRouterClient(createRouter({ ...deps, mcp: undefined } as RouterDeps), {
          context: {
            actor: {
              spaceId: "workspace-1",
              userId: "owner-1",
              email: "owner@rakazo.test",
              isDeploymentOwner: true,
            },
          } as never,
        }),
    };
  }

  const stdioInput = {
    transport: "stdio" as const,
    slug: "gmail",
    name: "Gmail",
    command: "npx",
    args: ["-y", "@klodr/gmail-mcp@2.0.2"],
  };

  it.each([
    [{ mcpStdioEnabled: false }, "Stdio MCP servers aren't available here"],
    [{ mcpStdioAllowedCommands: [] }, "Stdio MCP servers aren't available here"],
    [{ mcpStdioAllowedCommands: ["uvx"] }, "This stdio command isn't allowed here"],
  ])("refuses a stdio server this deployment can't run (%o)", async (env, message) => {
    const h = harness();
    Object.assign(h.deps.env, env);

    await expect(h.client.mcp.servers.create(stdioInput)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message,
    });
    await expect(
      h.client.mcp.servers.update({
        id: "server-1",
        config: { ...stdioInput, enabled: true, description: "", env: {} },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message });
    expect(h.deps.prisma.mcpServer.create).not.toHaveBeenCalled();
    expect(h.deps.prisma.mcpServer.update).not.toHaveBeenCalled();
    expect(h.probe).not.toHaveBeenCalled();
  });

  it("reports stdio support with the account", async () => {
    const h = harness();
    expect((await h.client.me()).mcpStdioEnabled).toBe(true);
    Object.assign(h.deps.env, { mcpStdioEnabled: false });
    expect((await h.client.me()).mcpStdioEnabled).toBe(false);
  });

  it("lets only admins add or change stdio servers", async () => {
    const h = harness();
    Object.assign(h.deps.env, { adminEmails: ["someone-else@rakazo.test"] });
    const refusal = { code: "FORBIDDEN", message: "Only admins can add local MCP servers" };

    expect((await h.client.me()).mcpStdioEnabled).toBe(false);
    await expect(h.client.mcp.servers.create(stdioInput)).rejects.toMatchObject(refusal);
    await expect(
      h.client.mcp.servers.update({
        id: "server-1",
        config: { ...stdioInput, enabled: true, description: "", env: {} },
      }),
    ).rejects.toMatchObject(refusal);
    await expect(
      h.client.mcp.servers.update({
        id: "server-1",
        config: {
          transport: "streamable_http",
          slug: "gmail",
          name: "Gmail",
          description: "",
          enabled: true,
          endpoint: "https://mcp.example.test/mcp",
          headers: {},
        },
      }),
    ).rejects.toMatchObject(refusal);
    expect(h.deps.prisma.mcpServer.create).not.toHaveBeenCalled();
    expect(h.deps.prisma.mcpServer.update).not.toHaveBeenCalled();

    await expect(
      h.client.mcp.servers.create({
        transport: "streamable_http",
        slug: "remote",
        name: "Remote",
        endpoint: "https://mcp.example.test/mcp",
      }),
    ).resolves.toMatchObject({ transport: "streamable_http" });
  });

  it("lists servers with their health", async () => {
    const h = harness({
      row: baseRow({
        healthStatus: "error",
        healthMessage: "spawn npx ENOENT",
        healthCheckedAt: new Date("2026-10-21T10:00:00.000Z"),
      }),
    });
    (h.deps.prisma.mcpServer as unknown as { findMany: unknown }).findMany = vi.fn(async () => [
      h.row(),
    ]);

    const [listed] = await h.client.mcp.servers.list();

    expect(listed?.health).toEqual({
      status: "error",
      message: "spawn npx ENOENT",
      code: null,
      toolCount: null,
      checkedAt: "2026-10-21T10:00:00.000Z",
    });
  });

  describe("test", () => {
    it("probes the server and returns the recorded health", async () => {
      const { client, probe } = harness();

      const tested = await client.mcp.servers.test({ id: "server-1" });

      expect(probe).toHaveBeenCalledTimes(1);
      expect(probe.mock.calls[0]?.[1]).toMatchObject({ spaceId: "workspace-1", userId: "owner-1" });
      expect(tested.health).toMatchObject({ status: "ok", toolCount: 4, message: null });
      expect(tested.health.checkedAt).not.toBeNull();
    });

    it("refuses another user's server without probing it", async () => {
      const { clientFor, probe } = harness();

      await expect(
        clientFor({ userId: "member-1" }).mcp.servers.test({ id: "server-1" }),
      ).rejects.toThrow();
      await expect(
        clientFor({ spaceId: "workspace-2" }).mcp.servers.test({ id: "server-1" }),
      ).rejects.toThrow();
      await expect(clientFor().mcp.servers.test({ id: "does-not-exist" })).rejects.toThrow();
      expect(probe).not.toHaveBeenCalled();
    });

    it("returns an error health instead of a 500 when the probe throws", async () => {
      const { client } = harness({
        probe: async () => {
          throw new Error("MCP stdio is disabled");
        },
      });

      const tested = await client.mcp.servers.test({ id: "server-1" });

      expect(tested.health).toMatchObject({
        status: "error",
        message: "Could not check this MCP server",
      });
    });

    it("says why it did not probe when the server still needs its OAuth account", async () => {
      const { client, probe } = harness({
        oauth: { status: "none", clientId: "client-1.apps.example.test", credential: true },
      });

      const tested = await client.mcp.servers.test({ id: "server-1" });

      expect(probe).not.toHaveBeenCalled();
      expect(tested.health.status).toBe("unknown");
      expect(tested.health.message).toMatch(/account/);
    });

    it.each([
      [{ secret: "fake-token" }, true],
      [{ headers: { Authorization: "fake-token" } }, true],
      [{ secret: "fake-token", env: { TOKEN: "{{oauth.access_token}}" } }, false],
      [{ secret: "fake-token", files: { CONFIG: "{{oauth.access_token}}" } }, false],
    ])(
      "checks static credentials unless templates need a grant: %j",
      async (material, shouldProbe) => {
        const h = harness({
          row: baseRow({ secretId: "secret-1" }),
          oauth: { status: "none", clientId: "fake-client", credential: true },
        });
        vi.mocked(h.deps.prisma.secret.findFirst).mockResolvedValue({
          id: "secret-1",
          ciphertext: "fake-ciphertext",
        } as never);
        vi.mocked(h.deps.secrets.load).mockResolvedValue(JSON.stringify(material));
        await h.client.mcp.servers.test({ id: "server-1" });
        expect(h.probe).toHaveBeenCalledTimes(shouldProbe ? 1 : 0);
      },
    );

    it("reports an error when this process has no MCP connector", async () => {
      const h = harness();

      const tested = await h.createRouterWithoutProbe().mcp.servers.test({ id: "server-1" });

      expect(tested.health.status).toBe("error");
    });
  });

  describe("automatic probe", () => {
    it("shows a new stdio server as installing and probes it in the background", async () => {
      const { client, probe, row } = harness({ row: null });

      const created = await client.mcp.servers.create(stdioInput);
      expect(created.health.status).toBe("installing");
      await flush();

      expect(probe).toHaveBeenCalledTimes(1);
      expect(row()?.healthStatus).toBe("ok");
    });

    it("probes a new remote server without claiming it is installing", async () => {
      const { client, probe } = harness({ row: null });

      const created = await client.mcp.servers.create({
        transport: "streamable_http",
        slug: "docs",
        name: "Docs",
        endpoint: "https://mcp.example.test/mcp",
      });
      await flush();

      expect(created.health.status).toBe("unknown");
      expect(probe).toHaveBeenCalledTimes(1);
    });

    it("does not fail the create when the probe fails", async () => {
      const { client, row } = harness({
        row: null,
        probe: async () => {
          throw new Error("boom");
        },
      });

      const created = await client.mcp.servers.create(stdioInput);
      await flush();

      expect(created.id).toBe("server-1");
      expect(row()).toMatchObject({
        healthStatus: "error",
        healthMessage: "Could not check this MCP server",
      });
    });

    it("does not probe a server whose OAuth account is not connected", async () => {
      const { client, probe, row } = harness({
        row: null,
        oauth: { status: "none", clientId: "client-1.apps.example.test", credential: true },
      });

      const created = await client.mcp.servers.create(stdioInput);
      await flush();

      expect(probe).not.toHaveBeenCalled();
      expect(created.health.status).toBe("unknown");
      expect(row()?.healthMessage).toMatch(/account/);
    });

    it("does not probe a disabled server", async () => {
      const { client, probe } = harness({ row: null });

      await client.mcp.servers.create({ ...stdioInput, enabled: false });
      await flush();

      expect(probe).not.toHaveBeenCalled();
    });

    it("resets health when the config changes and probes the new config", async () => {
      const { client, probe, row } = harness({
        row: baseRow({ healthStatus: "error", healthMessage: "old failure", healthToolCount: 2 }),
      });
      const seen: unknown[] = [];
      probe.mockImplementation(async () => {
        seen.push({ ...row() });
        return { status: "ok" };
      });

      const updated = await client.mcp.servers.update({
        id: "server-1",
        config: { ...stdioInput, name: "Gmail 2", args: ["-y", "@klodr/gmail-mcp@2.1.0"] },
      });
      await flush();

      expect(updated.revision).toBe(2);
      expect(updated.health.status).toBe("installing");
      expect(updated.health.message).toBeNull();
      expect(probe).toHaveBeenCalledTimes(1);
      expect(seen[0]).toMatchObject({ healthStatus: "installing", healthMessage: null });
    });

    it("does not probe when no MCP connector is wired", async () => {
      const h = harness({ row: null });

      const created = await h.createRouterWithoutProbe().mcp.servers.create(stdioInput);

      expect(created.health.status).toBe("unknown");
      expect(h.updateMany).not.toHaveBeenCalled();
    });

    it("keeps stdio arguments in the encrypted credential, never in the row or the response", async () => {
      const h = harness({ row: null });
      const put = vi.mocked(h.deps.secrets.put).mockResolvedValue({
        id: "secret-1",
        ciphertext: "v2:fake",
      } as never);

      const created = await h.client.mcp.servers.create({
        ...stdioInput,
        args: ["--api-key", "fake-key"],
      });

      expect(JSON.parse(String(put.mock.calls[0]?.[0]))).toMatchObject({
        args: ["--api-key", "fake-key"],
      });
      const data = vi.mocked(h.deps.prisma.mcpServer.create).mock.calls[0]?.[0].data;
      expect(data).not.toHaveProperty("args");
      expect(data).toMatchObject({ hasArgs: true, secretId: "secret-1" });
      expect(created).not.toHaveProperty("args");
      expect(created.hasArgs).toBe(true);
    });

    it("moves a server's plaintext arguments into its credential when it is saved", async () => {
      const h = harness({ row: baseRow({ args: ["--api-key", "fake-key"] }) });
      const put = vi.mocked(h.deps.secrets.put).mockResolvedValue({
        id: "secret-1",
        ciphertext: "v2:fake",
      } as never);

      const updated = await h.client.mcp.servers.update({
        id: "server-1",
        config: { ...stdioInput, args: [] },
      });

      expect(JSON.parse(String(put.mock.calls[0]?.[0]))).toMatchObject({
        args: ["--api-key", "fake-key"],
      });
      expect(h.row()).toMatchObject({ args: [], hasArgs: true, secretId: "secret-1" });
      expect(updated.hasArgs).toBe(true);
    });

    it("still reports arguments a server kept in plaintext", async () => {
      const h = harness();
      (h.deps.prisma.mcpServer as unknown as { findMany: unknown }).findMany = vi.fn(async () => [
        h.row(),
      ]);

      const [listed] = await h.client.mcp.servers.list();

      expect(listed).not.toHaveProperty("args");
      expect(listed?.hasArgs).toBe(true);
    });

    it("answers a sign-in the server refused as a refusal, and any other failure as a fault", async () => {
      const h = harness({
        row: baseRow({ transport: "streamable_http", endpoint: "https://mcp.example.test/mcp" }),
      });
      const begin = vi.fn();
      const complete = vi.fn();
      Object.assign(h.deps, { mcpOAuth: { ...(h.deps.mcpOAuth as object), begin, complete } });
      const handler = appHandler(h.deps);
      const call = async (path: string, json: unknown) => {
        const response = await handle(
          handler,
          new Request(`http://127.0.0.1/rpc/mcp/oauth/${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ json }),
          }),
          {
            prefix: "/rpc",
            context: {
              actor: {
                spaceId: "workspace-1",
                userId: "owner-1",
                email: "owner@rakazo.test",
                isDeploymentOwner: true,
              },
            },
          },
        );
        const body = (await response.json()) as { json: { message: string } };
        return { status: response.status, message: body.json.message };
      };
      const calls = [
        { path: "begin", input: { serverId: "server-1" }, fake: begin },
        {
          path: "complete",
          input: { sessionId: "session-1", code: "code", state: "session-1" },
          fake: complete,
        },
      ];
      for (const { path, input, fake } of calls) {
        fake.mockRejectedValueOnce(
          new McpOAuthRefusedError("MCP OAuth session is invalid or expired"),
        );
        await expect(call(path, input)).resolves.toEqual({
          status: 400,
          message: "MCP OAuth session is invalid or expired",
        });
        fake.mockRejectedValueOnce(new Error("pool timeout"));
        await expect(call(path, input)).resolves.toMatchObject({ status: 500 });
      }
    });

    it("asks for a client ID when the server cannot register one", async () => {
      const h = harness({
        row: baseRow({ transport: "streamable_http", endpoint: "https://mcp.example.test/mcp" }),
      });
      Object.assign(h.deps, {
        mcpOAuth: {
          ...(h.deps.mcpOAuth as object),
          begin: vi.fn().mockRejectedValue(new McpOAuthClientRequiredError(1)),
        },
      });
      const client = createRouterClient(createRouter(h.deps), {
        context: {
          actor: {
            spaceId: "workspace-1",
            userId: "owner-1",
            email: "owner@rakazo.test",
            isDeploymentOwner: true,
          },
        } as never,
      });

      await expect(
        client.mcp.oauth.begin({
          serverId: "server-1",
          redirectUri: "http://127.0.0.1:5173/mcp/oauth/callback",
        }),
      ).rejects.toMatchObject({ code: MCP_OAUTH_CLIENT_REQUIRED });
      expect(h.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "server-1", revision: 1 } }),
      );
      (h.deps.prisma.mcpServer as unknown as { findMany: unknown }).findMany = vi.fn(async () => [
        h.row(),
      ]);
      const [listed] = await client.mcp.servers.list();
      expect(listed?.health).toMatchObject({ status: "error", code: MCP_OAUTH_CLIENT_REQUIRED });
    });

    it.each([
      "http://localhost:5173/mcp/oauth/callback",
      "http://127.0.0.1:5180/mcp/oauth/callback",
      "https://127.0.0.1:5173/mcp/oauth/callback",
      "http://127.0.0.1:5173/other-callback",
    ])("rejects an unregistered callback before starting OAuth: %s", async (redirectUri) => {
      const h = harness({
        row: baseRow({
          transport: "streamable_http",
          endpoint: "https://mcp.example.test/mcp",
        }),
      });
      const begin = vi.fn();
      Object.assign(h.deps, {
        mcpOAuth: { ...(h.deps.mcpOAuth as object), begin },
      });
      const client = createRouterClient(createRouter(h.deps), {
        context: {
          actor: {
            spaceId: "workspace-1",
            userId: "owner-1",
            email: "owner@rakazo.test",
            isDeploymentOwner: true,
          },
        } as never,
      });

      await expect(
        client.mcp.oauth.begin({ serverId: "server-1", redirectUri }),
      ).rejects.toMatchObject({ code: "MCP_OAUTH_REDIRECT_MISMATCH", kind: "BAD_REQUEST" });
      expect(begin).not.toHaveBeenCalled();
    });

    it("uses the registered web callback when a native client omits the redirect", async () => {
      const h = harness({
        row: baseRow({ transport: "streamable_http", endpoint: "https://mcp.example.test/mcp" }),
      });
      const begin = vi.fn(async () => ({ status: "already_connected" as const }));
      Object.assign(h.deps, { mcpOAuth: { ...(h.deps.mcpOAuth as object), begin } });
      const client = createRouterClient(createRouter(h.deps), {
        context: {
          actor: {
            spaceId: "workspace-1",
            userId: "owner-1",
            email: "owner@rakazo.test",
            isDeploymentOwner: true,
          },
        } as never,
      });

      await expect(client.mcp.oauth.begin({ serverId: "server-1" })).resolves.toEqual({
        status: "already_connected",
      });
      expect(begin).toHaveBeenCalledWith(
        expect.objectContaining({
          redirectUri: new URL("/mcp/oauth/callback", h.deps.env.webOrigin).toString(),
        }),
      );
    });

    it("probes the server once its OAuth session completes", async () => {
      const h = harness({ row: baseRow() });
      const complete = vi.fn(async () => ({ serverId: "server-1", revision: 1 }));
      Object.assign(h.deps, {
        mcpOAuth: {
          ...(h.deps.mcpOAuth as object),
          complete,
        },
      });
      const client = createRouterClient(createRouter(h.deps), {
        context: {
          actor: {
            spaceId: "workspace-1",
            userId: "owner-1",
            email: "owner@rakazo.test",
            isDeploymentOwner: true,
          },
        } as never,
      });

      await client.mcp.oauth.complete({ sessionId: "session-1", code: "code", state: "session-1" });
      await flush();

      expect(complete).toHaveBeenCalledTimes(1);
      expect(h.probe).toHaveBeenCalledTimes(1);
    });

    it("drops a check from before sign-in as soon as its OAuth session completes", async () => {
      const h = harness({
        row: baseRow({
          transport: "streamable_http",
          endpoint: "https://mcp.example.test/mcp",
          command: null,
          args: [],
          healthStatus: "error",
          healthMessage: "HTTP 401",
        }),
        probe: () => new Promise(() => undefined),
      });
      Object.assign(h.deps, {
        mcpOAuth: {
          ...(h.deps.mcpOAuth as object),
          complete: vi.fn(async () => ({ serverId: "server-1", revision: 1 })),
        },
      });
      // A separate session lookup failing must not skip the reset: the completed sign-in names
      // its server.
      (h.deps.prisma as unknown as { mcpOAuthSession: unknown }).mcpOAuthSession = {
        findFirst: vi.fn(async () => {
          throw new Error("pool timeout");
        }),
      };

      await h
        .clientFor()
        .mcp.oauth.complete({ sessionId: "session-1", code: "code", state: "session-1" });

      // The new check is still running, so the list must not keep showing the old failure.
      expect(h.row()).toMatchObject({ healthStatus: "unknown", healthMessage: null });
      await flush();
      expect(h.probe).toHaveBeenCalledTimes(1);
    });

    it("keeps an edit's failed check that lands while its OAuth session completes", async () => {
      const h = harness({ row: baseRow({ revision: 1 }) });
      Object.assign(h.deps, {
        mcpOAuth: {
          ...(h.deps.mcpOAuth as object),
          complete: vi.fn(async () => {
            // The sign-in wrote revision 2; an edit (revision 3) and its failed check land
            // before the handler resets health.
            Object.assign(h.row() as Row, {
              revision: 3,
              healthStatus: "error",
              healthMessage: "HTTP 500",
            });
            return { serverId: "server-1", revision: 2 };
          }),
        },
      });

      await h
        .clientFor()
        .mcp.oauth.complete({ sessionId: "session-1", code: "code", state: "session-1" });
      await flush();

      expect(h.row()).toMatchObject({
        revision: 3,
        healthStatus: "error",
        healthMessage: "HTTP 500",
      });
      // The edit already checks its own settings.
      expect(h.probe).not.toHaveBeenCalled();
    });

    // Each API health write below runs after its server row was read; an edit (revision 2)
    // and its failed check that land in between must survive it.
    const editLandsDuring = (h: { row: () => Row | null }) =>
      Object.assign(h.row() as Row, {
        revision: 2,
        healthStatus: "error",
        healthMessage: "HTTP 500",
      });
    const stillFailing = { revision: 2, healthStatus: "error", healthMessage: "HTTP 500" };

    it("keeps an edit's failed check over a check of the old settings with no runtime", async () => {
      const h = harness();
      Object.assign(h.deps, {
        mcpOAuth: {
          ...(h.deps.mcpOAuth as object),
          summaryFor: vi.fn(async () => {
            editLandsDuring(h);
            return { status: "none", clientId: null, credential: true };
          }),
        },
      });
      await h.createRouterWithoutProbe().mcp.servers.test({ id: "server-1" });
      expect(h.row()).toMatchObject(stillFailing);
    });

    it("keeps an edit's failed check over a crashed check of the old settings", async () => {
      const h = harness({
        probe: async () => {
          editLandsDuring(h);
          throw new Error("crashed");
        },
      });
      await h.client.mcp.servers.test({ id: "server-1" }).catch(() => undefined);
      expect(h.row()).toMatchObject(stillFailing);
    });

    it("keeps an edit's failed check over an account-pending write for the old settings", async () => {
      const h = harness();
      Object.assign(h.deps, {
        mcpOAuth: {
          ...(h.deps.mcpOAuth as object),
          summaryFor: vi.fn(async () => {
            editLandsDuring(h);
            return { status: "none", clientId: "client-1", credential: false };
          }),
        },
      });
      await h
        .clientFor()
        .mcp.servers.test({ id: "server-1" })
        .catch(() => undefined);
      expect(h.row()).toMatchObject(stillFailing);
    });

    it("keeps an edit's failed check over the reset that starts a check of the old settings", async () => {
      const h = harness({ probe: () => new Promise(() => undefined) });
      Object.assign(h.deps, {
        mcpOAuth: {
          ...(h.deps.mcpOAuth as object),
          complete: vi.fn(async () => ({ serverId: "server-1", revision: 1 })),
          summaryFor: vi.fn(async () => {
            editLandsDuring(h);
            return { status: "connected", clientId: null, credential: true };
          }),
        },
      });
      await h
        .clientFor()
        .mcp.oauth.complete({ sessionId: "session-1", code: "code", state: "session-1" });
      await flush();
      expect(h.row()).toMatchObject(stillFailing);
    });

    it("resets health to account-pending for the revision a disconnect committed", async () => {
      const h = harness({ row: baseRow({ revision: 2, healthStatus: "ok" }) });
      Object.assign(h.deps, {
        mcpOAuth: { ...(h.deps.mcpOAuth as object), disconnect: vi.fn(async () => 2) },
      });

      await h.clientFor().mcp.oauth.disconnect({ serverId: "server-1" });

      expect(h.row()).toMatchObject({
        healthStatus: "unknown",
        healthMessage: "Connect this server's account to check it.",
      });
    });

    it("keeps a newer sign-in's failed check that lands before a disconnect resets health", async () => {
      const h = harness({ row: baseRow({ revision: 1 }) });
      Object.assign(h.deps, {
        mcpOAuth: {
          ...(h.deps.mcpOAuth as object),
          disconnect: vi.fn(async () => {
            // The disconnect committed revision 2; a new sign-in (revision 3) and its failed
            // check land before the handler resets health.
            Object.assign(h.row() as Row, {
              revision: 3,
              healthStatus: "error",
              healthMessage: "HTTP 500",
            });
            return 2;
          }),
        },
      });

      await h.clientFor().mcp.oauth.disconnect({ serverId: "server-1" });

      expect(h.row()).toMatchObject({
        revision: 3,
        healthStatus: "error",
        healthMessage: "HTTP 500",
      });
    });
  });
});

describe("private API connectors", () => {
  function privateDeps(mcpAllowPrivateEndpoint = false) {
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      ...data,
      id: "install-1",
      secretId: null,
      version: "1.0.0",
      digest: "sha256:fake",
      createdAt: new Date(0),
    }));
    const prisma = {
      capabilityInstall: { create },
      $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(prisma)),
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
        mcpAllowPrivateEndpoint,
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    return { create, handler: appHandler(deps) };
  }

  function actor(isDeploymentOwner: boolean): Actor {
    return {
      spaceId: "workspace-1",
      userId: isDeploymentOwner ? "owner-1" : "member-1",
      email: "user@rakazo.test",
      isDeploymentOwner,
    };
  }

  function rpc(path: string, json: unknown) {
    return new Request(`http://127.0.0.1/rpc/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json }),
    });
  }

  const installInput = {
    kind: "api",
    name: "Local API",
    source: "http://localhost:4000",
    config: {
      auth: { type: "none" },
      operations: [{ id: "list_items", method: "GET", path: "/items" }],
    },
  };

  it.each([
    ["a legacy owner under the instance flag", true, true],
    ["every user under the instance flag", false, true],
  ])("lets %s install a loopback API connector", async (_label, owner, flag) => {
    const { create, handler } = privateDeps(flag);
    const response = await handle(handler, rpc("capabilities/install", installInput), {
      prefix: "/rpc",
      context: { actor: actor(owner) },
    });

    expect(response.status).toBe(200);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("refuses a loopback API connector from a user who is not the deployment owner", async () => {
    const { create, handler } = privateDeps();
    const response = await handle(handler, rpc("capabilities/install", installInput), {
      prefix: "/rpc",
      context: { actor: actor(false) },
    });

    expect(response.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ["a line break", "fake-graphql-key\r\nx-injected: 1"],
    ["a character a header cannot carry", "fake-graphql-key-\u201Cquoted\u201D"],
  ])("refuses a GraphQL credential with %s without repeating it", async (_label, credential) => {
    const sink = createTestSink();
    const previous = getLogger();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    onTestFinished(() => installLogger(previous));
    const { create, handler } = privateDeps();
    const response = await handle(
      handler,
      rpc("capabilities/install", {
        kind: "graphql",
        name: "GraphQL",
        source: "https://graphql.example.test/graphql",
        config: { auth: { type: "bearer" } },
        credential,
      }),
      { prefix: "/rpc", context: { actor: actor(false) } },
    );

    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("fake-graphql-key");
    expect(JSON.stringify(sink.events)).not.toContain("fake-graphql-key");
    expect(create).not.toHaveBeenCalled();
  });
});
