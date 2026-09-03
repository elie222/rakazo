import { approvalEffectKey } from "@rakazo/core/node/approval-effect-key";
import { describe, expect, it, vi } from "vitest";
import {
  approvedCatalogReplay,
  approvedReplayArgs,
  catalogApprovalRequest,
  createApprovedEffectReplayQueue,
} from "./approval-effect.js";
import {
  InstalledConnectorProvider,
  importOpenApiDocument,
  prepareApiInstall,
  verifyMcpInstall,
} from "./installed-connectors.js";

describe("OpenAPI connector import", () => {
  it("uses the bounded catalog for a real large installed OpenAPI source", async () => {
    const install = {
      id: "api-1",
      kind: "api",
      name: "Contacts API",
      source: "https://api.example.test/v1",
      secretId: null,
      createdAt: new Date(0),
      config: {
        auth: { type: "none" },
        operations: Array.from({ length: 21 }, (_, index) => ({
          id: `operation_${String(index).padStart(2, "0")}`,
          description: index === 20 ? "Read the final contact" : `Operation ${index}`,
          method: "GET",
          path: `/contacts/${index}`,
          inputSchema: { type: "object", properties: { limit: { type: "integer" } } },
          readOnly: true,
        })),
      },
    };
    const prisma = {
      capabilityInstall: {
        findMany: vi.fn().mockResolvedValue([install]),
        findFirst: vi.fn().mockResolvedValue(install),
      },
    };
    const provider = new InstalledConnectorProvider(prisma as never, {} as never);
    const context = {
      workspaceId: "workspace-1",
      userId: "user-1",
      signal: new AbortController().signal,
    } as never;

    const [search, load, execute] = await provider.discoverTools(context);

    expect([search!.name, load!.name, execute!.name]).toEqual([
      "installed_search_tools",
      "installed_load_tool",
      "installed_execute_tool",
    ]);
    // Names may appear in the search description index; operation schemas must not.
    expect(JSON.stringify([search, load, execute])).not.toContain("/contacts/");
    expect(search!.description).toContain("operation_20");
    const events: unknown[] = [];
    for await (const event of provider.execute(
      {
        tool: search!.name,
        args: { query: "final contact" },
        executionId: "search",
        route: search!.route,
      },
      context,
    )) {
      events.push(event);
    }
    expect(events).toEqual([
      {
        type: "result",
        data: {
          tools: [
            {
              id: "api-1:operation_20",
              name: "operation_20",
              description: "Read the final contact",
              readOnly: true,
            },
          ],
        },
      },
    ]);
    const listed: unknown[] = [];
    for await (const event of provider.execute(
      {
        tool: search!.name,
        args: {},
        executionId: "list",
        route: search!.route,
      },
      context,
    )) {
      listed.push(event);
    }
    expect(listed).toEqual([
      {
        type: "result",
        data: {
          index: [
            {
              group: "Contacts API",
              names: Array.from(
                { length: 21 },
                (_, index) => `operation_${String(index).padStart(2, "0")}`,
              ),
            },
          ],
        },
      },
    ]);
    expect(JSON.stringify(listed)).not.toContain("inputSchema");
    expect(search!.description).toContain("Contacts API:");
    expect(search!.description).toContain("operation_00");
    await expect(
      provider.resolveCall(
        {
          tool: execute!.name,
          args: { id: "api-1:operation_20", arguments: { limit: 5 } },
          executionId: "execute",
          route: execute!.route,
        },
        context,
      ),
    ).resolves.toMatchObject({
      tool: { name: "operation_20", readOnly: true },
      call: {
        tool: "operation_20",
        args: { limit: 5 },
        route: { connectorId: "installed", resourceId: "api-1", toolName: "operation_20" },
      },
    });
  });

  it("executes an approved lazy call with authoritative normalized arguments", async () => {
    const install = {
      id: "api-approved",
      kind: "api",
      source: "https://93.184.216.34",
      secretId: null,
      createdAt: new Date(0),
      config: {
        auth: { type: "none" },
        operations: Array.from({ length: 21 }, (_, index) => ({
          id: `operation_${index}`,
          method: index === 20 ? "POST" : "GET",
          path: `/items/${index}`,
          inputSchema:
            index === 20
              ? {
                  type: "object",
                  properties: { count: { type: "integer", default: 3 } },
                  additionalProperties: false,
                }
              : { type: "object" },
        })),
      },
    };
    const prisma = {
      capabilityInstall: {
        findMany: vi.fn().mockResolvedValue([install]),
        findFirst: vi.fn().mockResolvedValue(install),
      },
    };
    let requestBody: unknown;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requestBody = JSON.parse(await request.text());
      return Response.json({ ok: true });
    });
    const provider = new InstalledConnectorProvider(prisma as never, {} as never, { fetch });
    const context = {
      workspaceId: "workspace-1",
      userId: "user-1",
      signal: new AbortController().signal,
    } as never;
    const execute = (await provider.discoverTools(context))[2]!;
    const marker = "__rakazoCatalogTool";
    const approvedRequest = catalogApprovalRequest(
      execute.name,
      { id: "api-approved:operation_20", arguments: {} },
      marker,
    );
    const queue = createApprovedEffectReplayQueue([
      { kind: "operation_20", request: approvedRequest },
    ]);
    const replay = approvedCatalogReplay(queue, execute.name, marker, true);
    const resolved = await provider.resolveCall(
      {
        tool: execute.name,
        args: replay.args!,
        executionId: "approved",
        route: execute.route,
      },
      context,
    );
    const args = approvedReplayArgs(queue.take(resolved!.tool.name)!, resolved!.call.args, marker);
    const events = [];

    for await (const event of provider.execute({ ...resolved!.call, args }, context)) {
      events.push(event);
    }

    expect(resolved!.tool.name).toBe("operation_20");
    expect(args).toEqual({ count: 3 });
    expect(approvalEffectKey("run", resolved!.tool.name, args)).toBe(
      approvalEffectKey("run", resolved!.tool.name, resolved!.call.args),
    );
    expect(requestBody).toEqual({ count: 3 });
    expect(events).toEqual([{ type: "result", data: { status: 200, data: { ok: true } } }]);
    expect(queue.assertDrained).not.toThrow();
  });

  it("keeps colliding OpenAPI operation names unique across installs", async () => {
    const installs = ["install-A", "install-B"].map((id, index) => ({
      id,
      kind: "api",
      source: `https://api.example.test/${id}`,
      secretId: null,
      createdAt: new Date(index),
      config: {
        auth: { type: "none" },
        operations: Array.from({ length: 11 }, (_, op) => ({
          id: op === 0 ? "delete_item" : `other_${op}`,
          name: op === 0 ? "delete_item" : `other_${op}`,
          method: "DELETE",
          path: `/${op}`,
          inputSchema: { type: "object", properties: { target: { type: "string" } } },
        })),
      },
    }));
    const prisma = {
      capabilityInstall: {
        findMany: vi.fn().mockResolvedValue(installs),
        findFirst: vi
          .fn()
          .mockImplementation(({ where }: { where: { id: string } }) =>
            Promise.resolve(installs.find((install) => install.id === where.id) ?? null),
          ),
      },
    };
    const provider = new InstalledConnectorProvider(prisma as never, {} as never);
    const context = {
      workspaceId: "workspace-1",
      userId: "user-1",
      signal: new AbortController().signal,
    } as never;

    const discovered = await provider.discoverTools(context);
    expect(discovered).toHaveLength(3);
    const [search, , execute] = discovered;
    const events: unknown[] = [];
    for await (const event of provider.execute(
      {
        tool: search!.name,
        args: { query: "delete_item" },
        executionId: "search",
        route: search!.route,
      },
      context,
    )) {
      events.push(event);
    }
    const tools = (events[0] as { data: { tools: Array<{ id: string; name: string }> } }).data
      .tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "installed__install-A__delete_item",
      "installed__install-B__delete_item",
    ]);

    const resolvedA = await provider.resolveCall(
      {
        tool: execute!.name,
        args: { id: "install-A:delete_item", arguments: { target: "a" } },
        executionId: "a",
        route: execute!.route,
      },
      context,
    );
    const resolvedB = await provider.resolveCall(
      {
        tool: execute!.name,
        args: { id: "install-B:delete_item", arguments: { target: "b" } },
        executionId: "b",
        route: execute!.route,
      },
      context,
    );
    expect(resolvedA?.tool.name).toBe("installed__install-A__delete_item");
    expect(resolvedB?.tool.name).toBe("installed__install-B__delete_item");
    expect(resolvedA?.tool.name).not.toBe(resolvedB?.tool.name);
  });

  it("exposes 20 installed tools directly and switches at 21", async () => {
    const makeInstall = (count: number) => ({
      id: "api-threshold",
      kind: "api",
      source: "https://api.example.test/v1",
      secretId: null,
      createdAt: new Date(0),
      config: {
        auth: { type: "none" },
        operations: Array.from({ length: count }, (_, index) => ({
          id: `operation_${index}`,
          method: "GET",
          path: `/${index}`,
          inputSchema: { type: "object" },
          readOnly: true,
        })),
      },
    });
    const context = {
      workspaceId: "workspace-1",
      userId: "user-1",
      signal: new AbortController().signal,
    } as never;

    const directPrisma = {
      capabilityInstall: {
        findMany: vi.fn().mockResolvedValue([makeInstall(20)]),
      },
    };
    const direct = await new InstalledConnectorProvider(
      directPrisma as never,
      {} as never,
    ).discoverTools(context);
    expect(direct).toHaveLength(20);
    expect(direct[0]?.name).toBe("operation_0");
    expect(direct.every((tool) => !tool.name.startsWith("installed__"))).toBe(true);

    const lazyPrisma = {
      capabilityInstall: {
        findMany: vi.fn().mockResolvedValue([makeInstall(21)]),
      },
    };
    const lazy = await new InstalledConnectorProvider(
      lazyPrisma as never,
      {} as never,
    ).discoverTools(context);
    expect(lazy.map((tool) => tool.name)).toEqual([
      "installed_search_tools",
      "installed_load_tool",
      "installed_execute_tool",
    ]);
  });

  it("returns no tools for an empty installed catalog", async () => {
    const provider = new InstalledConnectorProvider(
      { capabilityInstall: { findMany: vi.fn().mockResolvedValue([]) } } as never,
      {} as never,
    );
    await expect(
      provider.discoverTools({
        workspaceId: "workspace-1",
        userId: "user-1",
        signal: new AbortController().signal,
      } as never),
    ).resolves.toEqual([]);
  });

  it("executes an installed API operation whose id matches a catalog control", async () => {
    const install = {
      id: "api-reserved",
      kind: "api",
      source: "https://93.184.216.34",
      secretId: null,
      createdAt: new Date(0),
      config: {
        auth: { type: "none" },
        operations: [
          {
            id: "__catalog_execute",
            method: "GET",
            path: "/reserved",
            inputSchema: { type: "object" },
          },
        ],
      },
    };
    const prisma = {
      capabilityInstall: {
        findMany: vi.fn().mockResolvedValue([install]),
        findFirst: vi.fn().mockResolvedValue(install),
      },
    };
    const fetch = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    const provider = new InstalledConnectorProvider(prisma as never, {} as never, { fetch });
    const context = {
      workspaceId: "workspace-1",
      userId: "user-1",
      signal: new AbortController().signal,
    } as never;
    const [tool] = await provider.discoverTools(context);
    const call = { tool: tool!.name, args: {}, executionId: "reserved", route: tool!.route };

    await expect(provider.resolveCall(call, context)).resolves.toBeUndefined();
    const events = [];
    for await (const event of provider.execute(call, context)) events.push(event);

    expect(events).toEqual([{ type: "result", data: { status: 200, data: { ok: true } } }]);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("maps operation ids, parameters, and JSON bodies to bounded agent tools", () => {
    const imported = importOpenApiDocument({
      openapi: "3.1.0",
      servers: [{ url: "https://api.example.test/v1" }],
      paths: {
        "/contacts/{contactId}": {
          parameters: [
            {
              name: "contactId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          patch: {
            operationId: "updateContact",
            summary: "Update one contact",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { name: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(imported.baseUrl).toBe("https://api.example.test/v1");
    expect(imported.operations).toEqual([
      expect.objectContaining({
        id: "updateContact",
        method: "PATCH",
        path: "/contacts/{contactId}",
        readOnly: false,
        inputSchema: expect.objectContaining({ required: ["contactId", "body"] }),
      }),
    ]);
  });

  it("refuses ambiguous specs without stable operation ids", () => {
    expect(() =>
      importOpenApiDocument({
        servers: [{ url: "https://api.example.test" }],
        paths: { "/contacts": { get: { summary: "List contacts" } } },
      }),
    ).toThrow("operationId");
  });

  it("refuses credentials embedded in an imported OpenAPI server URL", () => {
    expect(() =>
      importOpenApiDocument({
        servers: [{ url: "https://api.example.test?token=fake-secret" }],
        paths: { "/contacts": { get: { operationId: "listContacts" } } },
      }),
    ).toThrow("encrypted credential field");
  });

  it("refuses sensitive headers that would become model-controlled inputs", () => {
    expect(() =>
      importOpenApiDocument({
        servers: [{ url: "https://api.example.test" }],
        paths: {
          "/contacts": {
            get: {
              operationId: "listContacts",
              parameters: [{ name: "Authorization", in: "header", schema: { type: "string" } }],
            },
          },
        },
      }),
    ).toThrow("unsafe header Authorization");
  });

  it("refuses credentials embedded in a persisted MCP URL", async () => {
    await expect(
      verifyMcpInstall({
        source: "https://connectors.example.test/mcp?access_token=fake-secret",
        config: { preset: "custom", auth: { type: "none" } },
      }),
    ).rejects.toThrow("encrypted credential field");
  });

  it("refuses model-controlled sensitive headers in authored API operations", async () => {
    await expect(
      prepareApiInstall({
        source: "https://93.184.216.34",
        config: {
          auth: { type: "bearer" },
          operations: [
            {
              id: "unsafe",
              method: "GET",
              path: "/contacts",
              headerParameters: ["authorization"],
            },
          ],
        },
        credential: "fake-credential",
      }),
    ).rejects.toThrow("Sensitive headers cannot be model-controlled");
  });
});
