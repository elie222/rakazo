import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
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
import { parseConnectorToolArgs, SELECTED_SCHEMA_MAX_BYTES } from "./lazy-tool-catalog.js";
import { parametersFor } from "./pi-runtime-tool-parameters.js";

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
              description: "GET /contacts/20. Provider description: Read the final contact",
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

  it("does not emit a replacement character when a response limit splits UTF-8", async () => {
    const install = {
      id: "api-utf8",
      kind: "api",
      source: "https://93.184.216.34",
      secretId: null,
      createdAt: new Date(0),
      config: {
        auth: { type: "none" },
        operations: [
          {
            id: "read_text",
            method: "GET",
            path: "/text",
            inputSchema: { type: "object" },
            readOnly: true,
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
    const prefix = "a".repeat(999_999);
    const fetch = vi.fn().mockResolvedValue(new Response(`${prefix}€`));
    const provider = new InstalledConnectorProvider(prisma as never, {} as never, { fetch });
    const context = {
      spaceId: "space-1",
      userId: "user-1",
      signal: new AbortController().signal,
    } as never;
    const [tool] = await provider.discoverTools(context);
    const events = [];

    for await (const event of provider.execute(
      { tool: tool!.name, args: {}, executionId: "utf8", route: tool!.route },
      context,
    )) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    const event = events[0] as {
      type: string;
      data: { status: number; data: string; truncated: boolean };
    };
    expect(event.type).toBe("result");
    expect(event.data.status).toBe(200);
    expect(event.data.truncated).toBe(true);
    expect(event.data.data).toHaveLength(prefix.length);
    expect(event.data.data.endsWith("a")).toBe(true);
    expect(event.data.data.includes("\uFFFD")).toBe(false);
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

  it("declares effects from the stored method and bounds provider descriptions", async () => {
    const operation = (id: string, method: string, readOnly: boolean, description?: string) => ({
      id,
      method,
      path: `/${id}`,
      inputSchema: { type: "object" },
      readOnly,
      ...(description ? { description } : {}),
    });
    const installs = [
      {
        id: "api-effects",
        kind: "api",
        source: "https://api.example.test/v1",
        secretId: null,
        createdAt: new Date(0),
        config: {
          auth: { type: "none" },
          operations: [
            operation("read_profile_card", "POST", false, `Safe read. ${"x".repeat(1_900)}`),
            operation("find_validator_record", "DELETE", true),
            operation("get_status", "GET", false),
            operation("list_items", "GET", true, "GET /list_items"),
          ],
        },
      },
      {
        id: "graphql-effects",
        kind: "graphql",
        source: "https://api.example.test/graphql",
        secretId: null,
        createdAt: new Date(1),
        config: {
          auth: { type: "none" },
          operations: [
            {
              id: "mutation_readNote",
              name: "read_note",
              operationType: "mutation",
              fieldName: "readNote",
              readOnly: true,
            },
          ],
        },
      },
    ];
    const provider = new InstalledConnectorProvider(
      { capabilityInstall: { findMany: vi.fn().mockResolvedValue(installs) } } as never,
      {} as never,
    );

    const tools = await provider.discoverTools({
      spaceId: "space-1",
      userId: "user-1",
      signal: new AbortController().signal,
    } as never);

    expect(tools.map((tool) => [tool.name, tool.readOnly])).toEqual([
      ["read_profile_card", false],
      ["find_validator_record", false],
      ["get_status", false],
      ["list_items", true],
      ["read_note", false],
    ]);
    const [card, record, , list, note] = tools;
    expect(card!.description.startsWith("POST /read_profile_card. Provider description: ")).toBe(
      true,
    );
    expect(card!.description.length).toBeLessThan(600);
    expect(record!.description).toBe("DELETE /find_validator_record");
    expect(list!.description).toBe("GET /list_items");
    expect(note!.description).toBe("mutation readNote");
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

  const prepareOpenApiFrom = (body: string) => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
      return new Response(body);
    });
    const prepared = prepareApiInstall({
      source: "https://api.example.test/openapi",
      config: { openApi: true, auth: { type: "none" } },
      remote: {
        fetch: fetch as unknown as typeof globalThis.fetch,
        resolveHostname: async () => [{ address: "203.0.113.10", family: 4 as const }],
      },
    });
    return { fetch, prepared };
  };

  it("imports an OpenAPI document published as YAML", async () => {
    const { fetch, prepared } = prepareOpenApiFrom(
      [
        "openapi: 3.0.3",
        "servers:",
        "  - url: https://api.example.test/v1",
        "paths:",
        "  /contacts/{contactId}:",
        "    get:",
        "      operationId: getContact",
        "      parameters:",
        "        - name: contactId",
        "          in: path",
        "          required: true",
        "          schema: { type: string }",
        "",
      ].join("\n"),
    );

    await expect(prepared).resolves.toMatchObject({
      source: "https://api.example.test/v1",
      operationCount: 1,
      config: {
        operations: [
          {
            id: "getContact",
            method: "GET",
            path: "/contacts/{contactId}",
            inputSchema: { required: ["contactId"] },
          },
        ],
      },
    });
    const headers = new Headers(fetch.mock.calls[0]![1]?.headers);
    expect(headers.get("accept")).toContain("application/yaml");
  });

  it("parses YAML mappings without duplicate-key checks or warnings", async () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    try {
      // Skipping duplicate-key checks keeps large mappings linear; the last key wins, as with
      // JSON.parse.
      const { prepared } = prepareOpenApiFrom(
        [
          "servers:",
          "  - url: https://api.example.test/old",
          "servers:",
          "  - url: https://api.example.test/v1",
          "x-note: !private-tag kept-out-of-logs",
          "paths:",
          "  /contacts:",
          "    get: { operationId: listContacts }",
          "",
        ].join("\n"),
      );

      await expect(prepared).resolves.toMatchObject({ source: "https://api.example.test/v1" });
      expect(emitWarning).not.toHaveBeenCalled();
    } finally {
      emitWarning.mockRestore();
    }
  });

  it("allows shared YAML anchors but refuses circular ones", async () => {
    const spec = (extra: string) =>
      [
        "servers: [{ url: https://api.example.test/v1 }]",
        "x-id: &id { type: string }",
        "paths:",
        "  /contacts/{contactId}:",
        "    get:",
        "      operationId: getContact",
        "      parameters:",
        "        - { name: contactId, in: path, required: true, schema: *id }",
        "        - { name: tag, in: query, schema: *id }",
        extra,
        "",
      ].join("\n");

    await expect(prepareOpenApiFrom(spec("")).prepared).resolves.toMatchObject({
      config: {
        operations: [
          {
            inputSchema: {
              properties: { contactId: { type: "string" }, tag: { type: "string" } },
            },
          },
        ],
      },
    });
    await expect(
      prepareOpenApiFrom(spec("x-loop: &loop { items: [*loop] }")).prepared,
    ).rejects.toThrow(/^OpenAPI document is not valid JSON or YAML$/);
  });

  it("still imports an OpenAPI document published as JSON", async () => {
    const { prepared } = prepareOpenApiFrom(
      JSON.stringify({
        openapi: "3.0.3",
        servers: [{ url: "https://api.example.test/v1" }],
        paths: { "/contacts": { get: { operationId: "listContacts" } } },
      }),
    );

    await expect(prepared).resolves.toMatchObject({
      source: "https://api.example.test/v1",
      config: { operations: [{ id: "listContacts", method: "GET", path: "/contacts" }] },
    });
  });

  it("refuses an OpenAPI document that is neither JSON nor YAML", async () => {
    for (const body of ["<!doctype html><title>Sign in</title>", "just text", "- a\n- b", ""]) {
      await expect(prepareOpenApiFrom(body).prepared).rejects.toThrow(
        /^OpenAPI document is not valid JSON or YAML$/,
      );
    }
  });

  it("keeps shared parameters referenced with $ref at path and operation level", () => {
    const imported = importOpenApiDocument({
      openapi: "3.1.0",
      servers: [{ url: "https://api.example.test/v1" }],
      components: {
        parameters: {
          projectId: { name: "projectId", in: "path", required: true, schema: { type: "string" } },
          fields: { name: "fields", in: "query", schema: { $ref: "#/components/schemas/Fields" } },
          ifMatch: { name: "If-Match", in: "header", schema: { type: "string" } },
        },
        schemas: { Fields: { type: "string", enum: ["default", "all"] } },
      },
      paths: {
        "/projects/{projectId}/items": {
          parameters: [{ $ref: "#/components/parameters/projectId" }],
          get: {
            operationId: "listItems",
            parameters: [
              { $ref: "#/components/parameters/fields" },
              { $ref: "#/components/parameters/ifMatch" },
            ],
          },
        },
      },
    });

    expect(imported.operations).toEqual([
      expect.objectContaining({
        id: "listItems",
        inputSchema: {
          type: "object",
          properties: {
            projectId: { type: "string" },
            fields: { type: "string", enum: ["default", "all"] },
            "If-Match": { type: "string" },
          },
          required: ["projectId"],
        },
        queryParameters: ["fields"],
        headerParameters: ["If-Match"],
      }),
    ]);
  });

  it("resolves $ref request bodies and body schemas so tool arguments validate", () => {
    const imported = importOpenApiDocument({
      openapi: "3.1.0",
      servers: [{ url: "https://api.example.test/v1" }],
      components: {
        schemas: {
          Item: {
            type: "object",
            properties: { settings: { $ref: "#/components/schemas/Settings" } },
            required: ["settings"],
          },
          Settings: { type: "object", properties: { archived: { type: "boolean" } } },
        },
        requestBodies: {
          Item: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/Item" } } },
          },
        },
      },
      paths: {
        "/items": {
          post: {
            operationId: "createItem",
            requestBody: { $ref: "#/components/requestBodies/Item" },
          },
          put: {
            operationId: "replaceItem",
            requestBody: {
              content: { "application/json": { schema: { $ref: "#/components/schemas/Item" } } },
            },
          },
        },
      },
    });

    const body = {
      type: "object",
      properties: {
        settings: { type: "object", properties: { archived: { type: "boolean" } } },
      },
      required: ["settings"],
    };
    expect(imported.operations).toEqual([
      expect.objectContaining({
        id: "createItem",
        inputSchema: { type: "object", properties: { body }, required: ["body"] },
      }),
      expect.objectContaining({
        id: "replaceItem",
        inputSchema: { type: "object", properties: { body } },
      }),
    ]);
    for (const operation of imported.operations) {
      const args = { body: { settings: { archived: true } } };
      expect(parseConnectorToolArgs(operation.inputSchema, args)).toEqual(args);
    }
  });

  it("refuses sensitive headers reached through a shared $ref parameter", () => {
    expect(() =>
      importOpenApiDocument({
        servers: [{ url: "https://api.example.test" }],
        components: {
          parameters: { auth: { name: "Authorization", in: "header", schema: { type: "string" } } },
        },
        paths: {
          "/contacts": {
            get: {
              operationId: "listContacts",
              parameters: [{ $ref: "#/components/parameters/auth" }],
            },
          },
        },
      }),
    ).toThrow("unsafe header Authorization");
  });

  it("sends shared $ref parameters where the spec declares them", async () => {
    const document = {
      openapi: "3.1.0",
      servers: [{ url: "https://93.184.216.34/v1" }],
      components: {
        parameters: {
          projectId: { name: "projectId", in: "path", required: true, schema: { type: "string" } },
          ifMatch: { name: "If-Match", in: "header", schema: { type: "string" } },
          dryRun: { name: "dryRun", in: "query", schema: { type: "boolean" } },
        },
        schemas: {
          Item: {
            type: "object",
            properties: { owner: { $ref: "https://schemas.example.test/owner.json" } },
          },
        },
      },
      paths: {
        "/projects/{projectId}/items": {
          parameters: [{ $ref: "#/components/parameters/projectId" }],
          get: {
            operationId: "listItems",
            parameters: [{ $ref: "#/components/parameters/ifMatch" }],
          },
          post: {
            operationId: "createItem",
            parameters: [{ $ref: "#/components/parameters/dryRun" }],
            requestBody: {
              content: { "application/json": { schema: { $ref: "#/components/schemas/Item" } } },
            },
          },
        },
      },
    };
    const fetch = vi.fn().mockResolvedValue(Response.json(document));
    const prepared = await prepareApiInstall({
      source: "https://93.184.216.34/openapi.json",
      config: { openApi: true, auth: { type: "none" } },
      remote: { fetch },
    });
    // The remote schema ref stays unresolved: installing fetched only the document itself.
    expect(fetch).toHaveBeenCalledOnce();
    expect(prepared.config.operations).toEqual([
      expect.objectContaining({ id: "listItems" }),
      expect.objectContaining({
        id: "createItem",
        inputSchema: {
          type: "object",
          properties: {
            projectId: { type: "string" },
            dryRun: { type: "boolean" },
            body: { type: "object", properties: { owner: { type: "object" } } },
          },
          required: ["projectId"],
        },
      }),
    ]);

    const install = {
      id: "api-shared-parameters",
      kind: "api",
      source: prepared.source,
      secretId: null,
      createdAt: new Date(0),
      config: prepared.config,
    };
    const prisma = { capabilityInstall: { findFirst: vi.fn().mockResolvedValue(install) } };
    fetch.mockReset();
    fetch.mockImplementation(async () => Response.json({ ok: true }));
    const provider = new InstalledConnectorProvider(prisma as never, {} as never, { fetch });
    const call = async (toolName: string, args: Record<string, unknown>) => {
      const context = { spaceId: "space-1", userId: "user-1", signal: AbortSignal.timeout(5_000) };
      const route = { connectorId: "installed", resourceId: install.id, toolName };
      for await (const _event of provider.execute(
        { tool: toolName, args, executionId: toolName, route },
        context as never,
      )) {
        // Only the outgoing request matters here.
      }
      const [url, init] = fetch.mock.lastCall as [URL, RequestInit];
      return {
        url: String(url),
        ifMatch: new Headers(init.headers).get("if-match"),
        body: init.body,
      };
    };

    await expect(call("listItems", { projectId: "p1", "If-Match": "v2" })).resolves.toMatchObject({
      url: "https://93.184.216.34/v1/projects/p1/items",
      ifMatch: "v2",
    });
    await expect(
      call("createItem", { projectId: "p1", dryRun: true, body: { owner: { id: "u1" } } }),
    ).resolves.toMatchObject({
      url: "https://93.184.216.34/v1/projects/p1/items?dryRun=true",
      body: JSON.stringify({ owner: { id: "u1" } }),
    });
  });

  it("lets an operation parameter override the path-level one with the same name and location", () => {
    const imported = importOpenApiDocument({
      servers: [{ url: "https://api.example.test" }],
      components: {
        parameters: { limit: { name: "limit", in: "query", schema: { type: "integer" } } },
      },
      paths: {
        "/items": {
          parameters: [{ name: "limit", in: "query", required: true, schema: {} }],
          get: {
            operationId: "listItems",
            parameters: [{ $ref: "#/components/parameters/limit" }],
          },
        },
      },
    });

    expect(imported.operations[0]).toMatchObject({
      inputSchema: { type: "object", properties: { limit: { type: "integer" } } },
      queryParameters: ["limit"],
    });
    expect(imported.operations[0]?.inputSchema).not.toHaveProperty("required");
  });

  it("bounds cyclic refs and how far refs can grow a tool's schema", () => {
    const tree = importOpenApiDocument({
      servers: [{ url: "https://api.example.test" }],
      components: {
        schemas: {
          Node: {
            type: "object",
            properties: {
              children: { type: "array", items: { $ref: "#/components/schemas/Node" } },
            },
          },
        },
      },
      paths: {
        "/nodes": {
          post: {
            operationId: "createNode",
            requestBody: {
              content: { "application/json": { schema: { $ref: "#/components/schemas/Node" } } },
            },
          },
        },
      },
    });
    expect(tree.operations[0]?.inputSchema.properties).toEqual({
      body: {
        type: "object",
        properties: { children: { type: "array", items: { type: "object" } } },
      },
    });

    // Each level references the next one ten times, so full inlining would grow exponentially.
    // Refs that would push the tool's schema past its size limit keep only the target's type.
    const schemas = Object.fromEntries(
      Array.from({ length: 10 }, (_, level) => [
        `Level${level}`,
        {
          type: "object",
          properties: Object.fromEntries(
            Array.from({ length: 10 }, (_, field) => [
              `field${field}`,
              { $ref: `#/components/schemas/Level${level + 1}` },
            ]),
          ),
        },
      ]),
    );
    const [level] = importOpenApiDocument({
      servers: [{ url: "https://api.example.test" }],
      components: { schemas },
      paths: {
        "/levels": {
          post: {
            operationId: "createLevel",
            requestBody: {
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/Level0" } },
              },
            },
          },
        },
      },
    }).operations;
    const levelSchema = JSON.stringify(level?.inputSchema);
    expect(levelSchema.length).toBeLessThan(30_000);
    expect(levelSchema).toContain(
      '"field0":{"type":"object","properties":{"field0":{"type":"object"',
    );
    expect(levelSchema).toContain('"field9":{"type":"object"}');

    const notes = { type: "string", description: "n".repeat(15_000) };
    const [search] = importOpenApiDocument({
      servers: [{ url: "https://api.example.test" }],
      components: { schemas: { Notes: notes } },
      paths: {
        "/notes": {
          get: {
            operationId: "searchNotes",
            parameters: ["first", "second"].map((name) => ({
              name,
              in: "query",
              schema: { $ref: "#/components/schemas/Notes" },
            })),
          },
        },
      },
    }).operations;
    // A parameter the limit leaves unresolved is still a string, as it is on the wire.
    expect(search?.inputSchema.properties).toEqual({ first: notes, second: { type: "string" } });

    // The limit applies per tool, so every operation can use the same large schema.
    const noteBody = {
      content: { "application/json": { schema: { $ref: "#/components/schemas/Notes" } } },
    };
    const shared = importOpenApiDocument({
      servers: [{ url: "https://api.example.test" }],
      components: { schemas: { Notes: notes } },
      paths: {
        "/notes": {
          post: { operationId: "createNote", requestBody: noteBody },
          put: { operationId: "replaceNote", requestBody: noteBody },
        },
      },
    });
    expect(shared.operations.map((operation) => operation.inputSchema.properties)).toEqual([
      { body: notes },
      { body: notes },
    ]);
  });

  it("follows $ref only where a schema is expected and keeps literal values unchanged", () => {
    const item = { type: "object", properties: { name: { type: "string" } } };
    const literal = { $ref: "#/components/schemas/Item" };
    const remote = { $ref: "https://schemas.example.test/item.json" };
    const [create] = importOpenApiDocument({
      servers: [{ url: "https://api.example.test" }],
      components: { schemas: { Item: item } },
      paths: {
        "/items": {
          post: {
            operationId: "createItem",
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      item: { $ref: "#/components/schemas/Item" },
                      tags: { type: "array", items: { $ref: "#/components/schemas/Item" } },
                      choice: { oneOf: [{ $ref: "#/components/schemas/Item" }, { type: "null" }] },
                    },
                    default: remote,
                    enum: [literal],
                    const: literal,
                    example: literal,
                    examples: [literal],
                    "x-template": literal,
                  },
                },
              },
            },
          },
        },
      },
    }).operations;

    expect(create?.inputSchema.properties).toEqual({
      body: {
        type: "object",
        properties: {
          item,
          tags: { type: "array", items: item },
          choice: { oneOf: [item, { type: "null" }] },
        },
        default: remote,
        enum: [literal],
        const: literal,
        example: literal,
        examples: [literal],
        "x-template": literal,
      },
    });
  });

  it("applies a $ref together with its sibling constraints", () => {
    const [create] = importOpenApiDocument({
      servers: [{ url: "https://api.example.test" }],
      components: {
        schemas: {
          Item: {
            type: "object",
            description: "An item",
            required: ["id", "name"],
            properties: {
              id: { type: "string", maxLength: 64 },
              name: { type: "string" },
              status: { type: "string", enum: ["draft", "active", "archived"] },
              count: { type: "integer", minimum: 0 },
            },
          },
          Slug: { type: "string", pattern: "^[a-z]+$" },
        },
      },
      paths: {
        "/items": {
          post: {
            operationId: "createItem",
            parameters: [
              {
                name: "slug",
                in: "query",
                schema: { $ref: "#/components/schemas/Slug", pattern: "^.{1,8}$" },
              },
            ],
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/Item",
                    description: "The item to create",
                    required: ["id"],
                    properties: {
                      id: { maxLength: 32 },
                      status: { enum: ["active", "archived", "deleted"] },
                      count: { minimum: 1 },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }).operations;

    expect(create?.inputSchema.properties).toEqual({
      // Two patterns can't be combined into one, so the referenced schema's is kept.
      slug: { type: "string", pattern: "^[a-z]+$" },
      body: {
        type: "object",
        description: "The item to create",
        required: ["id", "name"],
        properties: {
          id: { type: "string", maxLength: 32 },
          name: { type: "string" },
          status: { type: "string", enum: ["active", "archived"] },
          count: { type: "integer", minimum: 1 },
        },
      },
    });
    const schema = create!.inputSchema;
    expect(parseConnectorToolArgs(schema, { slug: "items" })).toEqual({ slug: "items" });
    expect(() => parseConnectorToolArgs(schema, { slug: "Items" })).toThrow();
    expect(() => parseConnectorToolArgs(schema, { body: { id: "a" } })).toThrow();
  });

  it("keeps a closed object's limits when a $ref sibling adds properties", () => {
    const closed = {
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: false,
    };
    const [create] = importOpenApiDocument({
      servers: [{ url: "https://api.example.test" }],
      components: {
        schemas: {
          Closed: closed,
          Open: { type: "object", properties: { a: { type: "string" } } },
        },
      },
      paths: {
        "/items": {
          post: {
            operationId: "createItem",
            parameters: [
              {
                name: "owner",
                in: "query",
                schema: { $ref: "https://schemas.example.test/owner.json", type: "string" },
              },
            ],
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      closedTarget: {
                        $ref: "#/components/schemas/Closed",
                        properties: { b: { type: "string" } },
                      },
                      closedSibling: {
                        $ref: "#/components/schemas/Open",
                        properties: { b: { type: "string" } },
                        additionalProperties: false,
                      },
                      described: {
                        $ref: "#/components/schemas/Closed",
                        description: "Kept closed",
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }).operations;

    const schema = create!.inputSchema;
    const body = (schema.properties as { body: { properties: Record<string, unknown> } }).body;
    // Merging `b` into either closed object would let it accept `b`, so the referenced
    // schema keeps its own properties.
    expect(body.properties.closedTarget).toEqual(closed);
    expect(body.properties.closedSibling).toEqual({
      type: "object",
      properties: { a: { type: "string" } },
    });
    // A sibling that adds no names still merges into the closed object.
    expect(body.properties.described).toEqual({ ...closed, description: "Kept closed" });
    // An unresolved ref keeps its siblings.
    expect((schema.properties as Record<string, unknown>).owner).toEqual({ type: "string" });
  });

  it("keeps the referenced enum when enums share no value, and siblings of an over-limit ref", () => {
    const [search] = importOpenApiDocument({
      servers: [{ url: "https://api.example.test" }],
      components: {
        schemas: {
          Status: { type: "string", enum: ["draft", "active"] },
          Notes: { type: "string", description: "n".repeat(25_000) },
        },
      },
      paths: {
        "/items": {
          get: {
            operationId: "searchItems",
            parameters: [
              {
                name: "status",
                in: "query",
                schema: { $ref: "#/components/schemas/Status", enum: ["archived"] },
              },
              {
                name: "notes",
                in: "query",
                schema: { $ref: "#/components/schemas/Notes", type: "string", maxLength: 8 },
              },
            ],
          },
        },
      },
    }).operations;

    expect(search?.inputSchema.properties).toEqual({
      status: { type: "string", enum: ["draft", "active"] },
      notes: { type: "string", maxLength: 8 },
    });
  });

  it("merges array items under a $ref with their siblings", () => {
    const [search] = importOpenApiDocument({
      servers: [{ url: "https://api.example.test" }],
      components: { schemas: { Ids: { type: "array", items: { type: "integer" } } } },
      paths: {
        "/items": {
          get: {
            operationId: "searchItems",
            parameters: [
              {
                name: "ids",
                in: "query",
                schema: { $ref: "#/components/schemas/Ids", items: { minimum: 1 }, maxItems: 5 },
              },
              {
                name: "tags",
                in: "query",
                schema: { $ref: "#/components/schemas/Ids", items: { type: "string" } },
              },
            ],
          },
        },
      },
    }).operations;

    expect(search?.inputSchema.properties).toEqual({
      ids: { type: "array", items: { type: "integer", minimum: 1 }, maxItems: 5 },
      // Conflicting item types keep the referenced schema's.
      tags: { type: "array", items: { type: "integer" } },
    });
  });

  it("keeps unresolved parameter refs as strings and unresolved bodies as objects", () => {
    const remote = "https://schemas.example.test/types.json";
    const [create] = importOpenApiDocument({
      servers: [{ url: "https://api.example.test" }],
      components: { schemas: { Loop: { $ref: "#/components/schemas/Loop" } } },
      paths: {
        "/items/{itemId}": {
          post: {
            operationId: "updateItem",
            parameters: [
              { name: "itemId", in: "path", required: true, schema: { $ref: remote } },
              {
                name: "label",
                in: "query",
                schema: { $ref: "#/components/schemas/Missing", maxLength: 10 },
              },
              { name: "count", in: "query", schema: { $ref: remote, type: "integer" } },
              { name: "If-Match", in: "header", schema: { $ref: "#/components/schemas/Loop" } },
            ],
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    $ref: remote,
                    description: "The item",
                  },
                },
              },
            },
          },
        },
      },
    }).operations;

    expect(create?.inputSchema.properties).toEqual({
      itemId: { type: "string" },
      label: { type: "string", maxLength: 10 },
      count: { type: "integer" },
      "If-Match": { type: "string" },
      body: { type: "object", description: "The item" },
    });
  });

  it("shows the model objects for recursive and remote refs nested in a body", () => {
    const [create] = importOpenApiDocument({
      servers: [{ url: "https://api.example.test" }],
      components: {
        schemas: {
          Node: {
            type: "object",
            properties: {
              name: { type: "string" },
              children: { type: "array", items: { $ref: "#/components/schemas/Node" } },
              owner: { $ref: "https://schemas.example.test/owner.json" },
              forest: { $ref: "#/components/schemas/Forest" },
            },
          },
          Forest: { type: "array", items: { $ref: "#/components/schemas/Forest" } },
        },
      },
      paths: {
        "/nodes": {
          post: {
            operationId: "createNode",
            requestBody: {
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/Node" } },
              },
            },
          },
        },
      },
    }).operations;

    const tool = { name: create!.id, description: "", inputSchema: create!.inputSchema };
    const args = {
      body: {
        name: "root",
        children: [{ name: "leaf", children: [{ name: "inner" }] }],
        owner: { id: 1 },
        forest: [[{ name: "tree" }]],
      },
    };
    const call = { type: "toolCall", id: "call-1", name: tool.name, arguments: args };
    const piTool = { ...tool, parameters: parametersFor(tool) };
    expect(validateToolArguments(piTool as never, call as never)).toEqual(args);
  });

  it("counts a schema's later fields before expanding its refs, so the tool stays loadable", () => {
    const [create] = importOpenApiDocument({
      servers: [{ url: "https://api.example.test" }],
      components: {
        schemas: { Item: { type: "object", description: "i".repeat(15_000) } },
      },
      paths: {
        "/items": {
          post: {
            operationId: "createItem",
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      item: { $ref: "#/components/schemas/Item" },
                      notes: { type: "string", description: "n".repeat(90_000) },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }).operations;

    const body = create?.inputSchema.properties as { body: { properties: { item: unknown } } };
    expect(body.body.properties.item).toEqual({ type: "object" });
    expect(Buffer.byteLength(JSON.stringify(create?.inputSchema))).toBeLessThanOrEqual(
      SELECTED_SCHEMA_MAX_BYTES,
    );
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

describe("private installed connectors", () => {
  const LOCAL_API = "http://127.0.0.1:4000";
  const config = {
    auth: { type: "none" },
    operations: [{ id: "list_items", method: "GET", path: "/items" }],
  };

  it("installs a loopback API only with the private-endpoint escape", async () => {
    await expect(prepareApiInstall({ source: LOCAL_API, config })).rejects.toThrow(
      "Connector URL must use HTTPS",
    );
    await expect(
      prepareApiInstall({ source: LOCAL_API, config, allowPrivateEndpoint: true }),
    ).resolves.toMatchObject({ source: LOCAL_API, operationCount: 1 });
  });

  it("requires operator configuration on every call regardless of stored owner", async () => {
    const install = {
      id: "api-local",
      kind: "api",
      name: "Local API",
      source: LOCAL_API,
      secretId: null,
      createdAt: new Date(0),
      config,
    };
    const deployment = { ownerUserId: "owner-1" };
    const prisma = {
      capabilityInstall: { findFirst: vi.fn().mockResolvedValue(install) },
      deploymentSettings: { findUnique: vi.fn(async () => deployment) },
    };
    const fetch = vi.fn(async () => Response.json({ items: [] }));
    const execute = async (userId: string, instanceFlag = false) => {
      const provider = new InstalledConnectorProvider(
        prisma as never,
        {} as never,
        { fetch: fetch as unknown as typeof globalThis.fetch },
        instanceFlag,
      );
      const events = [];
      for await (const event of provider.execute(
        {
          tool: "list_items",
          args: {},
          executionId: "call-1",
          route: { connectorId: "installed", resourceId: install.id, toolName: "list_items" },
        },
        { spaceId: "space-1", userId, signal: new AbortController().signal } as never,
      )) {
        events.push(event);
      }
      return events;
    };

    await expect(execute("owner-1")).resolves.toMatchObject([{ type: "error" }]);
    await expect(execute("member-1")).resolves.toEqual([
      { type: "error", message: "Connector URL must use HTTPS" },
    ]);
    await expect(execute("member-1", true)).resolves.toMatchObject([{ type: "result" }]);
    // Installed while this user owned the deployment: no longer reachable after the change.
    deployment.ownerUserId = "member-1";
    await expect(execute("owner-1")).resolves.toMatchObject([{ type: "error" }]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("declared JSON request bodies", () => {
  it.each([
    ["DELETE", true, { body: { ids: ["item-1"] } }, '{"ids":["item-1"]}', "?dryRun=true"],
    ["DELETE", true, { body: null }, "null", "?dryRun=true"],
    ["POST", true, { body: null }, "null", "?dryRun=true"],
    ["DELETE", "query", { body: "legacy" }, undefined, "?dryRun=true&body=legacy"],
    ["DELETE", "header", { body: "legacy" }, undefined, "?dryRun=true"],
    ["DELETE", false, { body: { ids: ["item-1"] } }, undefined, "?dryRun=true"],
    ["POST", "query", { body: null }, "{}", "?dryRun=true"],
    ["DELETE", true, {}, undefined, "?dryRun=true"],
    ["POST", true, { title: "legacy" }, '{"title":"legacy"}', "?dryRun=true"],
  ] as const)(
    "preserves %s bodies (declared: %s, args: %j)",
    async (method, declared, supplied, body, query) => {
      const imported = importOpenApiDocument({
        openapi: "3.1.0",
        servers: [{ url: "https://93.184.216.34/v1" }],
        paths: {
          "/items/{itemId}": {
            [method.toLowerCase()]: {
              operationId: "changeItems",
              parameters: [
                { name: "itemId", in: "path", required: true, schema: { type: "string" } },
                { name: "dryRun", in: "query", schema: { type: "boolean" } },
                { name: "If-Match", in: "header", schema: { type: "string" } },
                ...(typeof declared === "string"
                  ? [{ name: "body", in: declared, schema: { type: ["string", "null"] } }]
                  : []),
              ],
              ...(declared === true
                ? {
                    requestBody: {
                      content: {
                        "application/json": {
                          schema: {
                            type: ["object", "null"],
                            properties: { ids: { type: "array", items: { type: "string" } } },
                          },
                        },
                      },
                    },
                  }
                : {}),
            },
          },
        },
      });
      const args = parseConnectorToolArgs(imported.operations[0]!.inputSchema, {
        itemId: "item/1",
        dryRun: true,
        "If-Match": "v2",
        ...supplied,
      });
      const install = {
        id: "json-body",
        kind: "api",
        source: imported.baseUrl,
        secretId: null,
        config: { auth: { type: "none" }, operations: imported.operations },
      };
      const fetch = vi.fn(async () => Response.json({ ok: true }));
      const provider = new InstalledConnectorProvider(
        { capabilityInstall: { findFirst: vi.fn(async () => install) } } as never,
        {} as never,
        { fetch },
      );
      const events = [];
      for await (const event of provider.execute(
        {
          tool: "changeItems",
          args,
          executionId: "test",
          route: { connectorId: "installed", resourceId: install.id, toolName: "changeItems" },
        },
        { spaceId: "space-1", userId: "user-1", signal: AbortSignal.timeout(5000) } as never,
      ))
        events.push(event);
      expect(events).toMatchObject([{ type: "result" }]);
      expect(fetch).toHaveBeenCalledOnce();
      const [url, init] = fetch.mock.lastCall as unknown as [URL, RequestInit];
      expect(String(url)).toBe(`https://93.184.216.34/v1/items/item%2F1${query}`);
      expect(init.method).toBe(method);
      expect(new Headers(init.headers).get("if-match")).toBe("v2");
      expect(new Headers(init.headers).get("content-type")).toBe(
        body === undefined ? null : "application/json",
      );
      expect(init.body).toBe(body);
      if (declared === "header") expect(new Headers(init.headers).get("body")).toBe("legacy");
    },
  );
});
