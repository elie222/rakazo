import { describe, expect, it } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import { parseConnectorToolArgs } from "./lazy-tool-catalog.js";
import { jsonSchemaParameters, parametersFor } from "./pi-runtime.js";

describe("jsonSchemaParameters", () => {
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

  it("keeps primitive enums as literal unions", () => {
    const schema = jsonSchemaParameters({
      type: "object",
      properties: { mode: { type: "string", enum: ["fast", "slow"] } },
      required: ["mode"],
    }) as unknown as { properties: { mode: { anyOf: { const: unknown }[] } } };
    expect(schema.properties.mode.anyOf.map((member) => member.const)).toEqual(["fast", "slow"]);
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
