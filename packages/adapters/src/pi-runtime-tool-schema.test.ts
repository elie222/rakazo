import {
  FLEET_TOOL_NAMES,
  TICKET_COMMENT_MAX_LENGTH,
  TICKET_DESCRIPTION_MAX_LENGTH,
  TICKET_TITLE_MAX_LENGTH,
} from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import { lazyCatalogTools, parseConnectorToolArgs } from "./lazy-tool-catalog.js";
import {
  jsonSchemaParameters,
  parametersFor,
  prepareFleetArguments,
} from "./pi-runtime-tool-parameters.js";

describe("jsonSchemaParameters", () => {
  it("keeps the history query either/or guidance on the provider wire without a root union", () => {
    const tool = builtinAgentTools.find((entry) => entry.name === "search_history")!;
    const wire = JSON.parse(JSON.stringify(parametersFor(tool)));
    for (const field of ["query", "queries"]) {
      expect(wire.properties[field].description).toContain("never both; one is required");
    }
    expect(wire.properties.queries.description).toContain("3000 UTF-8 bytes");
    expect(wire).not.toHaveProperty("oneOf");
    // Root combinators cannot be sent to every provider; original-schema validation remains authoritative.
    expect(() => parseConnectorToolArgs(tool.inputSchema, {})).toThrow();
    expect(() =>
      parseConnectorToolArgs(tool.inputSchema, { query: "a", queries: ["b"] }),
    ).toThrow();
    expect(parseConnectorToolArgs(tool.inputSchema, { queries: ["a"] })).toEqual({
      queries: ["a"],
    });
  });

  it.each([
    ["ticket_create", "title", TICKET_TITLE_MAX_LENGTH, { title: "Ship" }],
    ["ticket_create", "description", TICKET_DESCRIPTION_MAX_LENGTH, { title: "Ship" }],
    ["ticket_update", "title", TICKET_TITLE_MAX_LENGTH, { id: "t1" }],
    ["ticket_update", "description", TICKET_DESCRIPTION_MAX_LENGTH, { id: "t1" }],
    ["ticket_comment", "body", TICKET_COMMENT_MAX_LENGTH, { id: "t1", body: "Ready" }],
  ] as const)("preserves the %s %s length limit on the model wire", (name, field, limit, base) => {
    const tool = builtinAgentTools.find((entry) => entry.name === name)!;
    const wire = JSON.parse(JSON.stringify(parametersFor(tool)));
    for (const schema of [tool.inputSchema, wire]) {
      expect(schema).toMatchObject({ properties: { [field]: { maxLength: limit } } });
      const input = { ...base, [field]: "x".repeat(limit) };
      expect(parseConnectorToolArgs(schema, input)).toEqual(input);
      expect(() =>
        parseConnectorToolArgs(schema, { ...base, [field]: "x".repeat(limit + 1) }),
      ).toThrow();
    }
  });

  it("exposes fields from a locally referenced allOf branch", () => {
    const tool = {
      name: "catalog_search",
      description: "Search a named catalog",
      inputSchema: {
        $defs: {
          "Base/filter": {
            type: "object",
            properties: { catalog: { type: "string", minLength: 1 } },
            required: ["catalog"],
          },
        },
        allOf: [
          { $ref: "#/$defs/Base~1filter" },
          { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        ],
      },
    };
    const original = JSON.stringify(tool.inputSchema);
    const wire = JSON.parse(JSON.stringify(parametersFor(tool)));
    expect(wire.properties).toEqual({
      catalog: { type: "string", minLength: 1 },
      query: { type: "string" },
    });
    expect(wire.required).toEqual(["catalog", "query"]);
    expect(wire).not.toHaveProperty("allOf");
    for (const schema of [tool.inputSchema, wire]) {
      expect(parseConnectorToolArgs(schema, { catalog: "books", query: "typescript" })).toEqual({
        catalog: "books",
        query: "typescript",
      });
      expect(() => parseConnectorToolArgs(schema, { query: "typescript" })).toThrow();
    }
    expect(JSON.stringify(tool.inputSchema)).toBe(original);
  });

  it("keeps root allOf fields and intersecting constraints through the Pi wire path", () => {
    const tool = {
      name: "catalog_page",
      description: "Read a bounded catalog page",
      inputSchema: {
        allOf: [
          {
            type: "object",
            properties: { limit: { type: "integer", minimum: 1 } },
            required: ["limit"],
          },
          {
            type: "object",
            properties: { limit: { type: "integer", maximum: 10 } },
          },
        ],
      },
    };
    const original = JSON.stringify(tool.inputSchema);
    const wire = JSON.parse(JSON.stringify(parametersFor(tool)));
    expect(wire).toEqual({
      type: "object",
      properties: {
        limit: {
          allOf: [
            { type: "integer", minimum: 1 },
            { type: "integer", maximum: 10 },
          ],
        },
      },
      required: ["limit"],
    });
    expect(parseConnectorToolArgs(wire, { limit: 5 })).toEqual(
      parseConnectorToolArgs(tool.inputSchema, { limit: 5 }),
    );
    for (const args of [{}, { limit: 0 }, { limit: 11 }, { limit: 1.5 }]) {
      expect(() => parseConnectorToolArgs(tool.inputSchema, args)).toThrow();
      expect(() => parseConnectorToolArgs(wire, args)).toThrow();
    }
    expect(JSON.stringify(tool.inputSchema)).toBe(original);
  });

  it("keeps allOf branch fields alongside root properties and required fields", () => {
    const wire = JSON.parse(
      JSON.stringify(
        parametersFor({
          name: "catalog_search",
          description: "Search a named catalog",
          inputSchema: {
            type: "object",
            properties: { catalog: { type: "string" } },
            required: ["catalog"],
            allOf: [
              {
                type: "object",
                properties: { query: { type: "string", minLength: 1 } },
                required: ["query"],
              },
            ],
          },
        }),
      ),
    );
    expect(wire).toEqual({
      type: "object",
      properties: { catalog: { type: "string" }, query: { type: "string", minLength: 1 } },
      required: ["catalog", "query"],
    });
  });

  it("preserves an allOf alternative before flattening an enclosing root union", () => {
    const wire = JSON.parse(
      JSON.stringify(
        parametersFor({
          name: "catalog_lookup",
          description: "Look up a catalog entry",
          inputSchema: {
            anyOf: [
              {
                allOf: [
                  { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
                  {
                    type: "object",
                    properties: { region: { type: "string" } },
                    required: ["region"],
                  },
                ],
              },
              { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
            ],
          },
        }),
      ),
    );
    expect(wire).toEqual({
      type: "object",
      properties: { id: { type: "string" }, region: { type: "string" }, query: { type: "string" } },
    });
  });

  it("keeps model-facing nullable parameters compatible with connector validation", () => {
    const tool = {
      name: "catalog_lookup",
      description: "Look up catalog entries",
      inputSchema: {
        type: "object",
        properties: { enabled: { type: ["boolean", "null"] } },
        required: ["enabled"],
      },
    };
    const wire = JSON.parse(JSON.stringify(parametersFor(tool)));
    for (const enabled of [true, false, null]) {
      expect(parseConnectorToolArgs(wire, { enabled })).toEqual(
        parseConnectorToolArgs(tool.inputSchema, { enabled }),
      );
    }
    expect(() => parseConnectorToolArgs(wire, { enabled: "false" })).toThrow();
    expect(() => parseConnectorToolArgs(wire, {})).toThrow();
  });

  it("preserves nullable object fields instead of advertising strings", () => {
    const schema = jsonSchemaParameters({
      type: "object",
      properties: {
        filter: {
          type: ["object", "null"],
          properties: { enabled: { type: "boolean" } },
          required: ["enabled"],
          additionalProperties: false,
        },
      },
      required: ["filter"],
    });
    expect(JSON.parse(JSON.stringify(schema))).toEqual({
      type: "object",
      required: ["filter"],
      properties: {
        filter: {
          anyOf: [
            {
              type: "object",
              properties: { enabled: { type: "boolean" } },
              required: ["enabled"],
              additionalProperties: false,
            },
            { type: "null" },
          ],
        },
      },
    });
  });

  it("preserves null branches in anyOf", () => {
    const schema = jsonSchemaParameters({
      type: "object",
      properties: { cursor: { anyOf: [{ type: "string" }, { type: "null" }] } },
    });
    expect(JSON.parse(JSON.stringify(schema)).properties.cursor).toEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
    });
  });

  it("preserves nullable array items and array constraints", () => {
    const schema = jsonSchemaParameters({
      type: "object",
      properties: {
        values: { type: "array", items: { type: ["boolean", "null"] }, minItems: 1 },
      },
    });
    expect(JSON.parse(JSON.stringify(schema)).properties.values).toEqual({
      type: "array",
      minItems: 1,
      items: { anyOf: [{ type: "boolean" }, { type: "null" }] },
    });
  });

  it("keeps a declared open object open on the model wire", () => {
    // Composio's COMPOSIO_MULTI_EXECUTE_TOOL shape: each item's `arguments` is a free-form map.
    // Without `additionalProperties: true`, constrained decoders on several providers treat
    // `{type: "object", properties: {}}` as closed and emit `arguments: {}`.
    const wire = JSON.parse(
      JSON.stringify(
        parametersFor({
          name: "COMPOSIO_MULTI_EXECUTE_TOOL",
          description: "Run tools",
          inputSchema: {
            type: "object",
            properties: {
              tools: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    tool_slug: { type: "string" },
                    arguments: { type: "object", additionalProperties: true },
                  },
                  required: ["tool_slug", "arguments"],
                },
              },
            },
            required: ["tools"],
          },
        }),
      ),
    );
    expect(wire.properties.tools.items.properties.arguments).toEqual({
      type: "object",
      properties: {},
      additionalProperties: true,
    });
  });

  it("sends a map with a value schema as an open object", () => {
    const schema = jsonSchemaParameters({
      type: "object",
      properties: {
        empty: { type: "object", additionalProperties: {} },
        ref: { type: "object", additionalProperties: { $ref: "#/$defs/Value" } },
      },
      $defs: { Value: { type: "number" } },
    });
    const wire = JSON.parse(JSON.stringify(schema)).properties;
    for (const field of [wire.empty, wire.ref]) {
      expect(field).toEqual({ type: "object", properties: {}, additionalProperties: true });
    }
  });

  it("keeps a string enum's allowed values, in order, as a plain enum", () => {
    // A literal union serialises as anyOf/const, which some gateways flatten to {} so the
    // model never sees the allowed values; {type: "string", enum} survives them.
    const schema = jsonSchemaParameters({
      type: "object",
      properties: { mode: { type: "string", enum: ["fast", "slow"] } },
      required: ["mode"],
    }) as unknown as { properties: { mode: Record<string, unknown> } };
    const mode = JSON.parse(JSON.stringify(schema.properties.mode));
    expect(mode).toEqual({ type: "string", enum: ["fast", "slow"] });
  });

  it("accepts a nullable enum without throwing", () => {
    expect(() =>
      jsonSchemaParameters({
        type: "object",
        properties: { cursor: { type: ["string", "null"], enum: ["a", "b", null] } },
      }),
    ).not.toThrow();
  });

  it("accepts enums whose members are objects or arrays", () => {
    expect(() =>
      jsonSchemaParameters({
        type: "object",
        properties: { filter: { type: "object", enum: [{ kind: "all" }, ["x"]] } },
      }),
    ).not.toThrow();
  });

  it("leaves a free-form object without an empty properties map", () => {
    const schema = jsonSchemaParameters({
      type: "object",
      properties: {
        id: { type: "string" },
        arguments: { type: "object", description: "Arguments matching the loaded schema" },
      },
      required: ["id", "arguments"],
    });
    const wire = JSON.parse(JSON.stringify(schema));
    expect(wire.properties.arguments).toEqual({
      type: "object",
      description: "Arguments matching the loaded schema",
    });
    expect(wire.properties.arguments).not.toHaveProperty("properties");
    // Free-form only on the wire: connector validation still rejects a non-object.
    expect(
      parseConnectorToolArgs(wire, { id: "a", arguments: { query: "q", numResults: 3 } }),
    ).toEqual({ id: "a", arguments: { query: "q", numResults: 3 } });
    expect(() => parseConnectorToolArgs(wire, { id: "a", arguments: "q" })).toThrow();
  });

  it.each([undefined, false])(
    "preserves root definitions for nested object references with additionalProperties=%s",
    (additionalProperties) => {
      const inputSchema = {
        type: "object",
        $defs: {
          P: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
        properties: { arguments: { type: "object", $ref: "#/$defs/P" } },
        required: ["arguments"],
        ...(additionalProperties === false ? { additionalProperties } : {}),
      };
      const original = JSON.stringify(inputSchema);
      const schema = jsonSchemaParameters(inputSchema, { description: "Tool parameters" });
      const wire = JSON.parse(JSON.stringify(schema));
      expect(wire).toEqual({ ...inputSchema, description: "Tool parameters" });
      expect(parseConnectorToolArgs(wire, { arguments: { query: "q" } })).toEqual({
        arguments: { query: "q" },
      });
      expect(() => parseConnectorToolArgs(wire, { arguments: {} })).toThrow();
      expect(() => parseConnectorToolArgs(wire, {})).toThrow();
      expect(JSON.stringify(inputSchema)).toBe(original);
    },
  );

  it("keeps the lazy catalog's executed-tool arguments free-form", () => {
    const execute = lazyCatalogTools("connectors", "mcp", "MCP").find(
      (tool) => tool.name === "connectors_execute_tool",
    )!;
    const wire = JSON.parse(JSON.stringify(parametersFor(execute)));
    expect(wire.required).toEqual(["id", "arguments"]);
    expect(wire.properties.arguments).toEqual({
      type: "object",
      description: "Arguments matching the loaded schema",
    });
    expect(parseConnectorToolArgs(wire, { id: "server:tool", arguments: { query: "q" } })).toEqual({
      id: "server:tool",
      arguments: { query: "q" },
    });
  });

  it("keeps an explicitly closed empty object closed", () => {
    const wire = JSON.parse(
      JSON.stringify(
        jsonSchemaParameters({ type: "object", properties: {}, additionalProperties: false }),
      ),
    );
    expect(wire).toEqual({ type: "object", properties: {}, additionalProperties: false });
  });
});

describe("update_bot parameters", () => {
  it("accepts notifyOnFinish as a boolean", () => {
    const tool = builtinAgentTools.find((entry) => entry.name === "update_bot");
    expect(tool).toBeTruthy();
    const schema = JSON.parse(JSON.stringify(parametersFor(tool!))) as Record<string, unknown>;
    expect(parseConnectorToolArgs(schema, { notifyOnFinish: false })).toEqual({
      notifyOnFinish: false,
    });
    expect(parseConnectorToolArgs(schema, { notifyOnFinish: true, name: "Scout" })).toEqual({
      notifyOnFinish: true,
      name: "Scout",
    });
    expect(() => parseConnectorToolArgs(schema, { notifyOnFinish: "false" })).toThrow();
  });

  it("still accepts avatar fields from the calling bot", () => {
    const tool = builtinAgentTools.find((entry) => entry.name === "update_bot");
    expect(tool).toBeTruthy();
    const schema = JSON.parse(JSON.stringify(parametersFor(tool!))) as Record<string, unknown>;
    expect(
      parseConnectorToolArgs(schema, {
        color: "#8B5CF6",
        artifact_id: "art-1",
        use_attached_image: true,
      }),
    ).toEqual({
      color: "#8B5CF6",
      artifact_id: "art-1",
      use_attached_image: true,
    });
  });
});

describe("bot management tool parameters", () => {
  const wireFor = (name: string) => {
    const tool = builtinAgentTools.find((entry) => entry.name === name);
    if (!tool) throw new Error(`missing ${name}`);
    return JSON.parse(JSON.stringify(parametersFor(tool))) as Record<string, unknown>;
  };

  it.each([...FLEET_TOOL_NAMES])(
    "%s serializes as one object schema without a root union",
    (name) => {
      const wire = wireFor(name);
      expect(wire.type).toBe("object");
      expect(wire.properties).toBeTruthy();
      for (const key of ["oneOf", "anyOf", "allOf"]) expect(wire).not.toHaveProperty(key);
    },
  );

  it("organize_bot clears a section only through clear_section", () => {
    expect(
      parseConnectorToolArgs(wireFor("organize_bot"), { bot_name: "Scout", clear_section: true }),
    ).toEqual({ bot_name: "Scout", clear_section: true });
    expect((wireFor("organize_bot").properties as Record<string, unknown>).section).toMatchObject({
      type: "string",
    });
  });

  it("create_child_routine carries the target and the timing fields", () => {
    const props = Object.keys(wireFor("create_child_routine").properties as object);
    expect(props).toEqual(
      expect.arrayContaining(["bot_id", "bot_name", "name", "prompt", "cron", "delaySeconds"]),
    );
  });

  it("update_bot carries bot_id for a child and first instructions, never a version", () => {
    const props = Object.keys(wireFor("update_bot").properties as object);
    expect(props).toContain("bot_id");
    expect(props).toContain("instructions");
    expect(props).not.toContain("expected_version");
    expect(Object.keys(wireFor("set_child_instructions").properties as object).sort()).toEqual([
      "bot_id",
      "bot_name",
      "expected_version",
      "instructions",
    ]);
  });

  it.each([...FLEET_TOOL_NAMES, "update_bot"])(
    "%s leaves null and blank optional values out instead of sending text",
    (name) => {
      const keys = Object.keys(wireFor(name).properties as object);
      for (const blank of [null, "", "  "]) {
        const raw = Object.fromEntries(keys.map((key) => [key, blank]));
        expect(prepareFleetArguments(name, raw), JSON.stringify(blank)).toEqual({});
      }
    },
  );

  it("keeps the instruction text exactly as sent", () => {
    const args = { bot_id: "b1", instructions: "  Keep\n spacing ", expected_version: "v1" };
    expect(prepareFleetArguments("set_child_instructions", args)).toEqual(args);
  });
});
