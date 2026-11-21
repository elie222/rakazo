import { createRouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import { appHandler, createRouter, handle } from "../router-test-support.js";

describe("MCP server deletion", () => {
  it("does not fail when a concurrent credential rotation already removed the old secret", async () => {
    const deleteServer = vi.fn().mockResolvedValue({ id: "server-1" });
    const deleteSecrets = vi.fn().mockResolvedValue({ count: 0 });
    const prisma = {
      mcpServer: {
        findMany: vi.fn(async () => []),
        findFirst: vi.fn().mockResolvedValue({ id: "server-1", secretId: "old-secret" }),
        delete: deleteServer,
      },
      mcpServerSpace: { findMany: vi.fn(async () => []) },
      secret: { deleteMany: deleteSecrets },
      message: { findMany: vi.fn().mockResolvedValue([]) },
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
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    const handler = new RPCHandler(createRouter(deps));

    const response = await handle(
      handler,
      new Request("http://127.0.0.1/rpc/mcp/servers/remove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { id: "server-1" } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ json: { ok: true } });
    expect(deleteServer).toHaveBeenCalledWith({ where: { id: "server-1" } });
    expect(deleteSecrets).toHaveBeenCalledWith({
      where: { id: "old-secret", userId: "user-1" },
    });
  });
});

describe("MCP prepared credential updates", () => {
  it("keeps slow secret I/O outside transactions and retries a concurrent OAuth edit", async () => {
    let clock = 0;
    let active = false;
    let writes = 0;
    const server = {
      id: "server",
      spaceId: "space",
      userId: "user",
      slug: "demo",
      name: "Demo",
      description: "",
      enabled: true,
      transport: "streamable_http",
      endpoint: "https://mcp.example.test/mcp",
      secretId: "old",
      revision: 1,
      args: [],
      env: {},
      headers: {},
      command: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    const rows = new Map([["old", { id: "old", ciphertext: "old-ref" }]]);
    const values = new Map([
      [
        "old-ref",
        JSON.stringify({ oauth: { tokens: { access_token: "old", token_type: "bearer" } } }),
      ],
    ]);
    const prisma = {
      mcpServer: {
        findMany: vi.fn(async () => []),
        findFirst: async () => ({ ...server }),
        update: async ({
          data,
        }: {
          data: { secretId: string; revision: { increment: number } };
        }) => {
          Object.assign(server, data, { revision: server.revision + data.revision.increment });
          return { ...server };
        },
      },
      mcpServerSpace: { findMany: vi.fn(async () => []) },
      secret: {
        findFirst: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
        create: async ({ data }: { data: { id: string; ciphertext: string } }) => {
          rows.set(data.id, data);
          return data;
        },
        deleteMany: async ({ where }: { where: { id: string } }) => {
          rows.delete(where.id);
          return { count: 1 };
        },
        count: async ({ where }: { where: { ciphertext: string } }) =>
          [...rows.values()].filter((row) => row.ciphertext === where.ciphertext).length,
      },
      botSecret: { count: async () => 0 },
      vaultCredential: { count: async () => 0 },
      integrationProviderConfig: { count: async () => 0 },
      $executeRaw: async () => 1,
      $queryRaw: async () => [],
      async $transaction(callback: (tx: unknown) => Promise<unknown>) {
        active = true;
        const start = clock;
        try {
          const result = await callback(prisma);
          if (clock - start > 5000) throw new Error("Transaction expired");
          return result;
        } finally {
          active = false;
        }
      },
    };
    const secrets = {
      load: async (ref: string) => {
        expect(active).toBe(false);
        clock += 15000;
        return values.get(ref)!;
      },
      put: async (plaintext: string) => {
        expect(active).toBe(false);
        clock += 15000;
        const id = `write-${++writes}`;
        values.set(id, plaintext);
        if (writes === 1) {
          rows.set("concurrent", { id: "concurrent", ciphertext: "concurrent-ref" });
          values.set(
            "concurrent-ref",
            JSON.stringify({
              oauth: { tokens: { access_token: "concurrent", token_type: "bearer" } },
            }),
          );
          server.secretId = "concurrent";
          server.revision++;
        }
        return { id, ref: id, ciphertext: id };
      },
      delete: vi.fn(async (ref: string) => {
        expect(active).toBe(false);
        values.delete(ref);
      }),
    };
    const deps = {
      prisma,
      secrets,
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "space",
      userId: "user",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    const client = createRouterClient(createRouter(deps), { context: { actor } as never });
    await client.mcp.servers.update({ id: "server", secret: "updated-key" });
    expect(writes).toBe(2);
    expect(values.has("write-1")).toBe(false);
    expect(JSON.parse(values.get(server.secretId)!)).toMatchObject({
      secret: "updated-key",
      oauth: { tokens: { access_token: "concurrent" } },
    });
  });
});

describe("MCP pre-registered OAuth client", () => {
  function harness(
    isDeploymentOwner = true,
    storedMaterial?: Record<string, unknown>,
    allowedCommands: readonly string[] = ["npx"],
  ) {
    const values = new Map<string, string>();
    const secretRows = new Map<string, { id: string; ciphertext: string }>();
    let server: Record<string, unknown> | undefined;
    if (storedMaterial) {
      values.set("cipher-0", JSON.stringify(storedMaterial));
      secretRows.set("secret-0", { id: "secret-0", ciphertext: "cipher-0" });
      server = {
        id: "server-1",
        spaceId: "workspace-1",
        userId: "owner-1",
        slug: "google-drive",
        name: "Google Drive",
        description: "",
        transport: "stdio",
        endpoint: null,
        command: "npx",
        args: [],
        env: { GOOGLE_ACCESS_TOKEN: true },
        files: { GOOGLE_CREDENTIALS_PATH: true },
        headers: {},
        secretId: "secret-0",
        enabled: true,
        revision: 1,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      };
    }
    const prisma = {
      mcpServer: {
        findMany: vi.fn(async () => []),
        findFirst: vi.fn(async () => (server ? { ...server } : null)),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const { revision: _revision, ...rest } = data;
          server = { ...server, ...rest, revision: Number(server?.revision) + 1 };
          return server;
        }),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          server = {
            ...data,
            id: "server-1",
            revision: 1,
            createdAt: new Date(0),
            updatedAt: new Date(0),
          };
          return server;
        }),
      },
      mcpServerSpace: { findMany: vi.fn(async () => []) },
      mcpOAuthSession: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      secret: {
        create: vi.fn(async ({ data }: { data: { id: string; ciphertext: string } }) => {
          secretRows.set(data.id, data);
          return data;
        }),
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) => secretRows.get(where.id)),
        deleteMany: vi.fn(async ({ where }: { where: { id: string } }) => {
          secretRows.delete(where.id);
          return { count: 1 };
        }),
      },
      user: {
        findUnique: vi.fn(async () => ({ email: "owner@rakazo.test", emailVerified: true })),
      },
      deploymentSettings: { findUnique: vi.fn().mockResolvedValue({ ownerUserId: "owner-1" }) },
      $executeRaw: vi.fn(async () => 1),
      $queryRaw: vi.fn(async () => []),
      $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(prisma)),
    } as unknown as PrismaClient;
    const secrets = {
      put: vi.fn(async (plaintext: string) => {
        values.set("cipher-1", plaintext);
        return { id: "secret-1", ciphertext: "cipher-1" };
      }),
      load: vi.fn(async (ciphertext: string) => values.get(ciphertext)!),
    };
    const deps = {
      prisma,
      secrets,
      remoteConnectors: { resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
        mcpAllowPrivateEndpoint: isDeploymentOwner,
        mcpStdioEnabled: true,
        mcpStdioAllowedCommands: allowedCommands,
        adminEmails: ["owner@rakazo.test"],
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "workspace-1",
      userId: isDeploymentOwner ? "owner-1" : "member-1",
      email: "owner@rakazo.test",
      isDeploymentOwner,
    } satisfies Actor;
    return {
      client: createRouterClient(createRouter(deps), { context: { actor } as never }),
      material: () => JSON.parse(values.get("cipher-1")!),
      server: () => server,
      secrets,
      prisma,
    };
  }

  it("stores the client encrypted and returns only its ID", async () => {
    const { client, material, server } = harness();

    const created = await client.mcp.servers.create({
      transport: "streamable_http",
      slug: "gmail",
      name: "Gmail",
      endpoint: "http://localhost:3100/mcp",
      oauthClient: { clientId: "client-1.apps.example.test", clientSecret: "client-secret" },
    });

    expect(created).toMatchObject({
      oauthClientId: "client-1.apps.example.test",
      oauthStatus: "none",
      hasSecret: true,
    });
    expect(JSON.stringify(created)).not.toContain("client-secret");
    expect(server()?.secretId).toBe("secret-1");
    expect(material()).toMatchObject({
      oauthClient: { client_id: "client-1.apps.example.test", client_secret: "client-secret" },
    });
  });

  it("reports a second server with the same name as a conflict", async () => {
    const { client, prisma } = harness();
    vi.mocked(prisma.mcpServer.create).mockRejectedValueOnce(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );

    await expect(
      client.mcp.servers.create({
        transport: "streamable_http",
        slug: "gmail",
        name: "Gmail",
        endpoint: "http://localhost:3100/mcp",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "An MCP server with that name already exists.",
    });
  });

  it("rejects a credential in the endpoint query, which would be stored in plaintext", async () => {
    const { client, prisma, secrets } = harness();

    await expect(
      client.mcp.servers.create({
        transport: "streamable_http",
        slug: "gmail",
        name: "Gmail",
        endpoint: "http://localhost:3100/mcp?region=us&api_key=sk-test-123",
      }),
    ).rejects.toMatchObject({
      name: "ConnectionSetupError",
      message: "Put api_key in a header instead of the server URL",
    });
    expect(secrets.put).not.toHaveBeenCalled();
    expect(prisma.mcpServer.create).not.toHaveBeenCalled();
  });

  it("does not report a stored credential for a lone OAuth generation marker", async () => {
    const { client, server } = harness(true);

    const created = await client.mcp.servers.create({
      transport: "streamable_http",
      slug: "gmail",
      name: "Gmail",
      endpoint: "http://localhost:3100/mcp",
    });
    expect(created.hasSecret).toBe(false);

    await client.mcp.oauth.disconnect({ serverId: created.id });
    // The disconnect of a never-connected server still leaves the generation marker row.
    expect(server()?.secretId).not.toBeNull();

    const checked = await client.mcp.servers.test({ id: created.id });
    expect(checked.hasSecret).toBe(false);
    expect(checked.oauthStatus).toBe("none");
  });

  describe("stdio server with host-managed OAuth", () => {
    const stdio = {
      transport: "stdio" as const,
      slug: "google-drive",
      name: "Google Drive",
      command: "npx",
      args: ["google-drive-mcp"],
    };
    const oauthClient = {
      clientId: "client-1.apps.example.test",
      clientSecret: "client-secret",
      scope: "https://www.googleapis.com/auth/drive.readonly",
      authorizationServer: "https://accounts.example.test",
    };

    it("stores the client and env references encrypted and returns the client ID", async () => {
      const { client, material, server } = harness();

      const created = await client.mcp.servers.create({
        ...stdio,
        env: { GOOGLE_ACCESS_TOKEN: "{{oauth.access_token}}" },
        oauthClient,
      });

      expect(created).toMatchObject({
        oauthClientId: "client-1.apps.example.test",
        oauthStatus: "none",
        envKeys: ["GOOGLE_ACCESS_TOKEN"],
      });
      expect(JSON.stringify(created)).not.toContain("client-secret");
      expect(server()?.env).toEqual({ GOOGLE_ACCESS_TOKEN: true });
      expect(material()).toMatchObject({
        env: { GOOGLE_ACCESS_TOKEN: "{{oauth.access_token}}" },
        oauthClient: {
          client_id: "client-1.apps.example.test",
          client_secret: "client-secret",
          scope: "https://www.googleapis.com/auth/drive.readonly",
          authorization_server: "https://accounts.example.test/",
        },
      });
    });

    it("rejects an unknown OAuth reference, naming the variable and the reference", async () => {
      const { client, secrets } = harness();

      await expect(
        client.mcp.servers.create({
          ...stdio,
          env: { GOOGLE_ACCESS_TOKEN: "Bearer {{oauth.id_token}}" },
          oauthClient,
        }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: expect.stringMatching(/GOOGLE_ACCESS_TOKEN.*oauth\.id_token/),
      });
      expect(secrets.put).not.toHaveBeenCalled();
    });

    it("rejects OAuth references when the server has no OAuth client", async () => {
      const { client, secrets } = harness();

      await expect(
        client.mcp.servers.create({
          ...stdio,
          env: { GOOGLE_ACCESS_TOKEN: "{{oauth.access_token}}" },
        }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: expect.stringMatching(/GOOGLE_ACCESS_TOKEN.*OAuth client/),
      });
      expect(secrets.put).not.toHaveBeenCalled();
    });

    describe("credential files", () => {
      const template = '{"refresh_token":"{{oauth.refresh_token}}"}';

      it("stores the file template encrypted and returns only its key", async () => {
        const { client, material, server } = harness();

        const created = await client.mcp.servers.create({
          ...stdio,
          env: {},
          files: { GOOGLE_CREDENTIALS_PATH: template },
          oauthClient,
        });

        expect(created.fileKeys).toEqual(["GOOGLE_CREDENTIALS_PATH"]);
        expect(JSON.stringify(created)).not.toContain("refresh_token");
        expect(server()?.files).toEqual({ GOOGLE_CREDENTIALS_PATH: true });
        expect(material().files).toEqual({ GOOGLE_CREDENTIALS_PATH: template });
      });

      it("returns no file keys for a server without files", async () => {
        const { client, server } = harness();

        const created = await client.mcp.servers.create({ ...stdio, env: {} });

        expect(created.fileKeys).toEqual([]);
        expect(server()?.files).toEqual({});
      });

      it("rejects an unknown reference in a file, naming the file key", async () => {
        const { client, secrets } = harness();

        await expect(
          client.mcp.servers.create({
            ...stdio,
            env: {},
            files: { GOOGLE_CREDENTIALS_PATH: "{{oauth.id_token}}" },
            oauthClient,
          }),
        ).rejects.toMatchObject({
          code: "BAD_REQUEST",
          message: expect.stringMatching(/GOOGLE_CREDENTIALS_PATH.*oauth\.id_token/),
        });
        expect(secrets.put).not.toHaveBeenCalled();
      });

      it("rejects file references when the server has no OAuth client", async () => {
        const { client, secrets } = harness();

        await expect(
          client.mcp.servers.create({
            ...stdio,
            env: {},
            files: { GOOGLE_CREDENTIALS_PATH: template },
          }),
        ).rejects.toMatchObject({
          code: "BAD_REQUEST",
          message: expect.stringMatching(/GOOGLE_CREDENTIALS_PATH.*OAuth client/),
        });
        expect(secrets.put).not.toHaveBeenCalled();
      });

      it("rejects a key used as both an environment variable and a file", async () => {
        const { client, secrets } = harness();

        await expect(
          client.mcp.servers.create({
            ...stdio,
            env: { GOOGLE_CREDENTIALS_PATH: "/tmp/x" },
            files: { GOOGLE_CREDENTIALS_PATH: template },
            oauthClient,
          }),
        ).rejects.toMatchObject({
          code: "BAD_REQUEST",
          message: expect.stringMatching(/GOOGLE_CREDENTIALS_PATH.*both/),
        });
        expect(secrets.put).not.toHaveBeenCalled();
      });

      describe("update", () => {
        const storedWithFile = {
          env: {},
          files: { GOOGLE_CREDENTIALS_PATH: template },
          oauthClient: { client_id: "client-1.apps.example.test", client_secret: "client-secret" },
        };
        const base = {
          id: "server-1",
          config: { ...stdio, enabled: true, description: "", env: {} },
        };

        it("replaces the files with the supplied set", async () => {
          const { client, material, server } = harness(true, storedWithFile);

          const updated = await client.mcp.servers.update({
            ...base,
            config: { ...base.config, files: { OTHER_PATH: "{{oauth.access_token}}" } },
          });

          expect(updated.fileKeys).toEqual(["OTHER_PATH"]);
          expect(server()?.files).toEqual({ OTHER_PATH: true });
          expect(material().files).toEqual({ OTHER_PATH: "{{oauth.access_token}}" });
        });

        it("keeps the stored files when the update omits them", async () => {
          const { client, material } = harness(true, storedWithFile);

          const updated = await client.mcp.servers.update(base);

          expect(updated.fileKeys).toEqual(["GOOGLE_CREDENTIALS_PATH"]);
          expect(material().files).toEqual({ GOOGLE_CREDENTIALS_PATH: template });
        });

        it("rejects kept file references once the update removes the OAuth client", async () => {
          const { client, secrets } = harness(true, storedWithFile);

          await expect(
            client.mcp.servers.update({
              ...base,
              config: { ...base.config, oauthClient: null },
            }),
          ).rejects.toMatchObject({
            code: "BAD_REQUEST",
            message: expect.stringMatching(/GOOGLE_CREDENTIALS_PATH.*OAuth client/),
          });
          expect(secrets.put).not.toHaveBeenCalled();
        });

        it("rejects an env variable that collides with a kept file", async () => {
          const { client, secrets } = harness(true, storedWithFile);

          await expect(
            client.mcp.servers.update({
              ...base,
              config: { ...base.config, env: { GOOGLE_CREDENTIALS_PATH: "/tmp/x" } },
            }),
          ).rejects.toMatchObject({
            code: "BAD_REQUEST",
            message: expect.stringMatching(/GOOGLE_CREDENTIALS_PATH.*both/),
          });
          expect(secrets.put).not.toHaveBeenCalled();
        });

        it("drops the files but keeps the arguments when the credential is cleared", async () => {
          const { client, material, server } = harness(true, storedWithFile);

          const updated = await client.mcp.servers.update({
            ...base,
            config: { ...base.config, oauthClient: null, clearCredential: true },
          });

          expect(updated.fileKeys).toEqual([]);
          expect(server()?.files).toEqual({});
          expect(material()).toEqual({ args: stdio.args });
        });

        it("drops the secret when the credential is cleared from a server without arguments", async () => {
          const { client, material, server } = harness(true, storedWithFile);

          await client.mcp.servers.update({
            ...base,
            config: {
              ...base.config,
              command: "npx",
              args: [],
              oauthClient: null,
              clearCredential: true,
            },
          });

          expect(server()?.secretId).toBeNull();
          expect(material).toThrow();
        });
      });
    });

    it("refuses a private authorization server from a user who is not the deployment owner", async () => {
      const { client, secrets } = harness(false);

      await expect(
        client.mcp.servers.create({
          ...stdio,
          env: { GOOGLE_ACCESS_TOKEN: "{{oauth.access_token}}" },
          oauthClient: { ...oauthClient, authorizationServer: "http://localhost:3100" },
        }),
      ).rejects.toMatchObject({
        name: "ConnectionSetupError",
        message: expect.stringMatching(/HTTPS/),
      });
      expect(secrets.put).not.toHaveBeenCalled();
    });

    describe("update", () => {
      const update = {
        id: "server-1",
        config: {
          ...stdio,
          enabled: true,
          description: "",
          env: { GOOGLE_ACCESS_TOKEN: "{{oauth.access_token}}" },
        },
      };
      const stored = {
        env: { GOOGLE_ACCESS_TOKEN: "{{oauth.access_token}}" },
        oauthClient: {
          client_id: "client-1.apps.example.test",
          client_secret: "client-secret",
          scope: "drive.readonly",
          authorization_server: "https://accounts.example.test/",
        },
        oauth: { tokens: { access_token: "granted" } },
      };

      it("rechecks a retained issuer before storing updated material", async () => {
        const { client, secrets } = harness(false, {
          ...stored,
          oauthClient: { ...stored.oauthClient, authorization_server: "https://127.0.0.1/" },
        });
        await expect(client.mcp.servers.update(update)).rejects.toMatchObject({
          name: "ConnectionSetupError",
        });
        expect(secrets.put).not.toHaveBeenCalled();
      });

      it("rejects references once the update removes the OAuth client", async () => {
        const { client, secrets } = harness(true, stored);

        await expect(
          client.mcp.servers.update({
            ...update,
            config: { ...update.config, oauthClient: null },
          }),
        ).rejects.toMatchObject({
          code: "BAD_REQUEST",
          message: expect.stringMatching(/GOOGLE_ACCESS_TOKEN.*OAuth client/),
        });
        expect(secrets.put).not.toHaveBeenCalled();
      });

      it("rejects an unknown reference even when the stored client is kept", async () => {
        const { client, secrets } = harness(true, stored);

        await expect(
          client.mcp.servers.update({
            ...update,
            config: { ...update.config, env: { GOOGLE_ACCESS_TOKEN: "{{oauth.id_token}}" } },
          }),
        ).rejects.toMatchObject({
          code: "BAD_REQUEST",
          message: expect.stringMatching(/GOOGLE_ACCESS_TOKEN.*oauth\.id_token/),
        });
        expect(secrets.put).not.toHaveBeenCalled();
      });

      it("keeps the stored client and its grant when the update leaves the client out", async () => {
        const { client, material } = harness(true, stored);

        const updated = await client.mcp.servers.update(update);

        expect(updated.oauthClientId).toBe("client-1.apps.example.test");
        expect(material()).toEqual({ ...stored, args: stdio.args });
      });

      it("clears the grant when the update changes the scope", async () => {
        const { client, material } = harness(true, stored);

        await client.mcp.servers.update({
          ...update,
          config: {
            ...update.config,
            oauthClient: {
              clientId: "client-1.apps.example.test",
              scope: "drive",
              authorizationServer: "https://accounts.example.test",
            },
          },
        });

        expect(material().oauth).toBeUndefined();
        expect(material().oauthClient).toEqual({
          client_id: "client-1.apps.example.test",
          client_secret: "client-secret",
          scope: "drive",
          authorization_server: "https://accounts.example.test/",
        });
      });

      it("clears the stored credential when the command changes and none is sent", async () => {
        const { client, server, secrets, prisma } = harness(
          true,
          { args: [...stdio.args, "--token", "stored-token"] },
          ["npx", "node"],
        );

        const updated = await client.mcp.servers.update({
          ...update,
          config: { ...stdio, command: "node", args: [], env: {}, enabled: true, description: "" },
        });

        expect(updated.hasSecret).toBe(false);
        expect(updated.hasArgs).toBe(false);
        expect(server()?.secretId).toBeNull();
        expect(secrets.put).not.toHaveBeenCalled();
        expect(prisma.secret.deleteMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: expect.objectContaining({ id: "secret-0" }) }),
        );
      });

      it("deletes a stored credential that holds only an empty env record", async () => {
        const { client, server, secrets, prisma } = harness(true, { env: {} });

        const updated = await client.mcp.servers.update({
          ...update,
          config: { ...stdio, args: [], env: {}, enabled: true, description: "" },
        });

        expect(updated.hasSecret).toBe(false);
        expect(server()?.secretId).toBeNull();
        expect(secrets.put).not.toHaveBeenCalled();
        expect(prisma.secret.deleteMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: expect.objectContaining({ id: "secret-0" }) }),
        );
      });
    });

    it("allows a private authorization server only with operator configuration", async () => {
      const { client } = harness();

      await expect(
        client.mcp.servers.create({
          ...stdio,
          env: { GOOGLE_ACCESS_TOKEN: "{{oauth.access_token}}" },
          oauthClient: { ...oauthClient, authorizationServer: "http://localhost:3100" },
        }),
      ).resolves.toMatchObject({ oauthClientId: "client-1.apps.example.test" });
    });
  });
});

describe("MCP loopback endpoints", () => {
  const LOOPBACK = "http://localhost:3100/api/auth/get-session";

  function mcpDeps(mcpAllowPrivateEndpoint = false) {
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      ...data,
      id: "server-1",
      secretId: null,
      revision: 1,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    }));
    const prisma = {
      mcpServer: {
        findMany: vi.fn(async () => []),
        create,
        findFirst: vi
          .fn()
          .mockResolvedValue({ id: "server-1", endpoint: LOOPBACK, secretId: null }),
      },
      mcpServerSpace: { findMany: vi.fn(async () => []) },
      mcpOAuthSession: {
        count: vi.fn().mockResolvedValue(0),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      secret: { findFirst: vi.fn() },
      deploymentSettings: { findUnique: vi.fn().mockResolvedValue({ ownerUserId: "owner-1" }) },
      $executeRaw: vi.fn(async () => 0),
      $queryRaw: vi.fn(async () => []),
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

  const createInput = {
    transport: "streamable_http",
    slug: "local",
    name: "Local",
    endpoint: LOOPBACK,
  };

  it("refuses a loopback endpoint from a user who is not the deployment owner", async () => {
    const { create, handler } = mcpDeps();
    const response = await handle(handler, rpc("mcp/servers/create", createInput), {
      prefix: "/rpc",
      context: { actor: actor(false) },
    });

    expect(response.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("allows a loopback endpoint under explicit operator configuration", async () => {
    const { create, handler } = mcpDeps(true);
    const response = await handle(handler, rpc("mcp/servers/create", createInput), {
      prefix: "/rpc",
      context: { actor: actor(true) },
    });

    expect(response.status).toBe(200);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("refuses to start OAuth against a stored loopback endpoint for a non-owner", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      const { handler } = mcpDeps();
      const response = await handle(
        handler,
        rpc("mcp/oauth/begin", {
          serverId: "server-1",
          redirectUri: "http://127.0.0.1:5173/mcp/oauth/callback",
        }),
        { prefix: "/rpc", context: { actor: actor(false) } },
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as { json: { message: string } };
      expect(body.json.message).toMatch(/HTTPS/);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
