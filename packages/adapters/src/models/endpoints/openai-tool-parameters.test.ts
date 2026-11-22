import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { expectLinearTime } from "@rakazo/contracts/test-timing";
import { describe, expect, it } from "vitest";
import { parametersFor } from "../../runtime/pi/tools/pi-runtime-tool-parameters.js";
import { builtinAgentTools } from "../../tools/builtin.tool-definition.js";
import {
  normalizeOpenAiToolParameters,
  openAiToolParametersNeedNormalization,
} from "./openai-tool-parameters.js";

describe("normalizeOpenAiToolParameters", () => {
  it("conjoins referenced fields with sibling constraints and follows local reference chains", () => {
    const normalized = normalizeOpenAiToolParameters({
      $defs: {
        Alias: { $ref: "#/$defs/Base" },
        Base: { properties: { limit: { type: "integer", minimum: 1 } }, required: ["limit"] },
      },
      allOf: [
        {
          $ref: "#/$defs/Alias",
          properties: { limit: { type: "integer", maximum: 10 } },
        },
      ],
    });
    expect(normalized.properties).toEqual({
      limit: {
        allOf: [
          { type: "integer", minimum: 1 },
          { type: "integer", maximum: 10 },
        ],
      },
    });
    expect(normalized.required).toEqual(["limit"]);
    expect(normalized).not.toHaveProperty("allOf");
  });

  it("stops cyclic local references while keeping their inline fields", () => {
    const normalized = normalizeOpenAiToolParameters({
      $defs: {
        Base: {
          allOf: [
            { $ref: "#/$defs/Base" },
            { properties: { query: { type: "string" } }, required: ["query"] },
          ],
        },
      },
      allOf: [{ $ref: "#/$defs/Base" }, { $ref: "#/$defs/Base" }],
    });
    expect(normalized.properties).toEqual({ query: { type: "string" } });
    expect(normalized.required).toEqual(["query"]);
  });

  it.each(["#/$defs/missing", "#/%ZZ", "https://example.test/schema", "#/constructor"])(
    "leaves unresolved or external references unfetched: %s",
    (ref) => {
      const normalized = normalizeOpenAiToolParameters({
        allOf: [{ $ref: ref }, { properties: { query: { type: "string" } } }],
      });
      expect(normalized.properties).toEqual({ query: { type: "string" } });
    },
  );

  it("resolves URI-encoded JSON pointers through arrays", () => {
    const normalized = normalizeOpenAiToolParameters({
      $defs: { "group name": { anyOf: [{ properties: { query: { type: "string" } } }] } },
      allOf: [{ $ref: "#/$defs/group%20name/anyOf/0" }],
    });
    expect(normalized.properties).toEqual({ query: { type: "string" } });
  });

  it("fills properties for a zero-argument object schema", () => {
    expect(normalizeOpenAiToolParameters({ type: "object" })).toEqual({
      type: "object",
      properties: {},
    });
  });

  it("keeps an empty properties map and does not invent parameters", () => {
    expect(normalizeOpenAiToolParameters({ type: "object", properties: {} })).toEqual({
      type: "object",
      properties: {},
    });
  });

  it("flattens a root union, which Anthropic rejects, into one object schema", () => {
    const normalized = normalizeOpenAiToolParameters({
      anyOf: [
        {
          type: "object",
          properties: { label: { type: "string" }, a: { type: "string" } },
          required: ["label", "a"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: { label: { type: "string" }, b: { type: "string" } },
          required: ["label", "b"],
          additionalProperties: false,
        },
      ],
    });
    expect(normalized).toEqual({
      type: "object",
      properties: { label: { type: "string" }, a: { type: "string" }, b: { type: "string" } },
      required: ["label"],
      additionalProperties: false,
    });
  });

  it("keeps every variant of a field that differs between root union branches", () => {
    const normalized = normalizeOpenAiToolParameters({
      oneOf: [
        { type: "object", properties: { action: { const: "start" } }, required: ["action"] },
        { type: "object", properties: { action: { const: "stop" } }, required: ["action"] },
      ],
    });
    expect(normalized).toEqual({
      type: "object",
      properties: { action: { anyOf: [{ const: "start" }, { const: "stop" }] } },
      required: ["action"],
    });
  });

  it("requires every field of a root allOf", () => {
    const normalized = normalizeOpenAiToolParameters({
      allOf: [
        { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        { type: "object", properties: { b: { type: "string" } }, required: ["b"] },
      ],
    });
    expect(normalized.required).toEqual(["a", "b"]);
    expect(normalized.allOf).toBeUndefined();
  });

  it("intersects differing specs for the same field under a root allOf", () => {
    const normalized = normalizeOpenAiToolParameters({
      allOf: [
        { type: "object", properties: { n: { type: "integer", minimum: 0 } } },
        { type: "object", properties: { n: { type: "integer", maximum: 10 } } },
      ],
    });
    expect(normalized).toEqual({
      type: "object",
      properties: {
        n: {
          allOf: [
            { type: "integer", minimum: 0 },
            { type: "integer", maximum: 10 },
          ],
        },
      },
    });
  });

  it("combines sibling allOf and oneOf fields and required constraints", () => {
    expect(
      normalizeOpenAiToolParameters({
        type: "object",
        allOf: [{ properties: { projectId: { type: "string" } }, required: ["projectId"] }],
        oneOf: [
          {
            properties: { action: { const: "start" }, startAt: { type: "string" } },
            required: ["action", "startAt"],
          },
          {
            properties: { action: { const: "stop" }, reason: { type: "string" } },
            required: ["action", "reason"],
          },
        ],
      }),
    ).toEqual({
      type: "object",
      properties: {
        projectId: { type: "string" },
        action: { anyOf: [{ const: "start" }, { const: "stop" }] },
        startAt: { type: "string" },
        reason: { type: "string" },
      },
      required: ["projectId", "action"],
    });
  });

  it("conjoins overlapping root, allOf, and union property constraints", () => {
    expect(
      normalizeOpenAiToolParameters({
        type: "object",
        properties: { count: { type: "integer" } },
        allOf: [{ properties: { count: { minimum: 1 } }, required: ["count"] }],
        oneOf: [{ properties: { count: { const: 1 } } }, { properties: { count: { const: 2 } } }],
      }),
    ).toEqual({
      type: "object",
      properties: {
        count: {
          allOf: [{ type: "integer" }, { minimum: 1 }, { anyOf: [{ const: 1 }, { const: 2 }] }],
        },
      },
      required: ["count"],
    });
  });

  it("conjoins sibling anyOf and oneOf alternatives", () => {
    expect(
      normalizeOpenAiToolParameters({
        type: "object",
        anyOf: [
          { properties: { value: { type: "string" } }, required: ["value"] },
          { properties: { value: { type: "number" } }, required: ["value"] },
        ],
        oneOf: [
          {
            properties: { value: { const: "ready" }, mode: { const: "text" } },
            required: ["mode"],
          },
          {
            properties: { value: { const: 1 }, mode: { const: "numeric" } },
            required: ["mode"],
          },
        ],
      }),
    ).toEqual({
      type: "object",
      properties: {
        value: {
          allOf: [
            { anyOf: [{ type: "string" }, { type: "number" }] },
            { anyOf: [{ const: "ready" }, { const: 1 }] },
          ],
        },
        mode: { anyOf: [{ const: "text" }, { const: "numeric" }] },
      },
      required: ["value", "mode"],
    });
  });

  it("preserves required, additionalProperties, and existing properties", () => {
    expect(
      normalizeOpenAiToolParameters({
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      }),
    ).toEqual({
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    });
  });

  it("replaces a non-object type with object without inventing fields", () => {
    expect(normalizeOpenAiToolParameters({ type: "string" })).toEqual({
      type: "object",
      properties: {},
    });
  });

  it("treats nullish or non-object input as an empty object schema", () => {
    expect(normalizeOpenAiToolParameters(undefined)).toEqual({
      type: "object",
      properties: {},
    });
    expect(normalizeOpenAiToolParameters(null)).toEqual({
      type: "object",
      properties: {},
    });
    expect(normalizeOpenAiToolParameters([])).toEqual({
      type: "object",
      properties: {},
    });
  });

  it("flattens pure nested anyOf branches and deduplicates identical members", () => {
    const blank = { anyOf: [{ type: "null" }, { type: "string", pattern: "^\\s*$" }] };
    const normalized = normalizeOpenAiToolParameters({
      oneOf: [
        { properties: { on: { anyOf: [{ type: "boolean" }, ...blank.anyOf] } } },
        { properties: { on: blank } },
      ],
    });
    expect(normalized.properties).toEqual({
      on: {
        anyOf: [{ type: "boolean" }, { type: "null" }, { type: "string", pattern: "^\\s*$" }],
      },
    });
  });

  it("drops redundant primitive and pattern branches when an unconstrained branch exists", () => {
    const normalized = normalizeOpenAiToolParameters({
      oneOf: [
        {
          properties: {
            cron: { type: "string", description: "5-field cron" },
            unit: { type: "string", enum: ["minutes", "hours"] },
          },
        },
        {
          properties: {
            cron: { anyOf: [{ type: "null" }, { type: "string", pattern: "^\\s*$" }] },
            unit: { anyOf: [{ type: "null" }, { type: "string", pattern: "^\\s*$" }] },
          },
        },
        {
          properties: {
            cron: { type: "string" },
          },
        },
      ],
    });
    expect(normalized.properties).toEqual({
      cron: { anyOf: [{ type: "string", description: "5-field cron" }, { type: "null" }] },
      unit: {
        anyOf: [
          { type: "string", enum: ["minutes", "hours"] },
          { type: "null" },
          { type: "string", pattern: "^\\s*$" },
        ],
      },
    });
  });

  it("preserves annotated nested anyOf objects and explicit empty anyOf arrays", () => {
    const normalized = normalizeOpenAiToolParameters({
      oneOf: [
        { properties: { annotated: { anyOf: [{ type: "string" }], description: "keep me" } } },
        { properties: { annotated: { type: "null" } } },
        { properties: { empty: { anyOf: [] } } },
        { properties: { empty: { type: "null" } } },
      ],
    });
    expect(normalized.properties).toEqual({
      annotated: {
        anyOf: [{ anyOf: [{ type: "string" }], description: "keep me" }, { type: "null" }],
      },
      empty: { anyOf: [{ anyOf: [] }, { type: "null" }] },
    });
  });

  it("preserves a singleton anyOf property shared identically across root and union branches", () => {
    const singleton = { anyOf: [{ type: "string" }] };
    const normalized = normalizeOpenAiToolParameters({
      type: "object",
      properties: { x: singleton },
      oneOf: [
        { properties: { x: singleton, a: { type: "string" } } },
        { properties: { x: singleton, b: { type: "string" } } },
      ],
    });
    expect(normalized.properties).toEqual({
      x: { anyOf: [{ type: "string" }] },
      a: { type: "string" },
      b: { type: "string" },
    });
  });

  it("preserves coercion order when promoting a described primitive over an earlier bare primitive", () => {
    const inputSchema = {
      oneOf: [
        { properties: { timing: { type: "string" } } },
        { properties: { timing: { type: "integer" } } },
        { properties: { timing: { type: "string", description: "cron expression" } } },
      ],
    };
    const normalized = normalizeOpenAiToolParameters(inputSchema);
    expect(normalized.properties).toEqual({
      timing: {
        anyOf: [{ type: "string", description: "cron expression" }, { type: "integer" }],
      },
    });
    const validated = validateToolArguments(
      {
        name: "test_tool",
        description: "test",
        parameters: parametersFor({
          name: "test_tool",
          description: "test",
          inputSchema,
        }),
      },
      { type: "toolCall", id: "1", name: "test_tool", arguments: { timing: 1.5 } },
    );
    expect(validated).toEqual({ timing: "1.5" });
  });

  it("preserves coercion order when a constrained branch precedes an intervening type", () => {
    const flatInputSchema = {
      oneOf: [
        { properties: { timing: { type: "string", pattern: "^\\s*$" } } },
        { properties: { timing: { type: "integer" } } },
        { properties: { timing: { type: "string", description: "cron expression" } } },
      ],
    };
    const flatNormalized = normalizeOpenAiToolParameters(flatInputSchema);
    expect(flatNormalized.properties).toEqual({
      timing: {
        anyOf: [
          { type: "string", pattern: "^\\s*$" },
          { type: "integer" },
          { type: "string", description: "cron expression" },
        ],
      },
    });
    expect(
      validateToolArguments(
        {
          name: "flat_tool",
          description: "test",
          parameters: parametersFor({
            name: "flat_tool",
            description: "test",
            inputSchema: flatInputSchema,
          }),
        },
        { type: "toolCall", id: "1", name: "flat_tool", arguments: { timing: 1.5 } },
      ),
    ).toEqual({ timing: "1.5" });

    const nestedInputSchema = {
      oneOf: [
        {
          properties: {
            timing: { anyOf: [{ type: "string", minLength: 5 }, { type: "integer" }] },
          },
        },
        { properties: { timing: { type: "string", description: "any text" } } },
      ],
    };
    const nestedNormalized = normalizeOpenAiToolParameters(nestedInputSchema);
    expect(nestedNormalized.properties).toEqual({
      timing: {
        anyOf: [
          { anyOf: [{ type: "string", minLength: 5 }, { type: "integer" }] },
          { type: "string", description: "any text" },
        ],
      },
    });
    expect(
      validateToolArguments(
        {
          name: "nested_tool",
          description: "test",
          parameters: parametersFor({
            name: "nested_tool",
            description: "test",
            inputSchema: nestedInputSchema,
          }),
        },
        { type: "toolCall", id: "1", name: "nested_tool", arguments: { timing: 1.5 } },
      ),
    ).toEqual({ timing: 1 });
    expect(
      validateToolArguments(
        {
          name: "nested_tool_direct",
          description: "test",
          parameters: nestedNormalized as never,
        },
        { type: "toolCall", id: "2", name: "nested_tool_direct", arguments: { timing: 1.5 } },
      ),
    ).toEqual({ timing: 1 });
  });

  it("preserves union grouping when later union branches span multiple earlier unions", () => {
    const inputSchema = {
      oneOf: [
        { properties: { value: { anyOf: [{ type: "integer", minimum: 10 }, { type: "null" }] } } },
        { properties: { value: { anyOf: [{ type: "number", maximum: 1 }, { type: "object" }] } } },
        {
          properties: {
            value: {
              anyOf: [
                { type: "integer", minimum: 10 },
                { type: "number", maximum: 1 },
              ],
            },
          },
        },
      ],
    };
    const normalized = normalizeOpenAiToolParameters(inputSchema);
    expect(
      validateToolArguments(
        {
          name: "multi_union_tool",
          description: "test",
          parameters: parametersFor({
            name: "multi_union_tool",
            description: "test",
            inputSchema,
          }),
        },
        { type: "toolCall", id: "1", name: "multi_union_tool", arguments: { value: 1.5 } },
      ),
    ).toEqual({ value: 1 });
    expect(
      validateToolArguments(
        {
          name: "multi_union_tool_direct",
          description: "test",
          parameters: normalized as never,
        },
        { type: "toolCall", id: "2", name: "multi_union_tool_direct", arguments: { value: 1.5 } },
      ),
    ).toEqual({ value: 1 });
  });

  it("does not recursively flatten a nested constrained union into an outer unconstrained sibling", () => {
    const inputSchema = {
      oneOf: [
        {
          properties: {
            value: {
              anyOf: [
                { anyOf: [{ type: "string", minLength: 5 }, { type: "integer" }] },
                { type: "string" },
              ],
            },
          },
        },
        { properties: { value: { type: "null" } } },
      ],
    };
    const normalized = normalizeOpenAiToolParameters(inputSchema);
    expect(
      validateToolArguments(
        {
          name: "deep_union_tool",
          description: "test",
          parameters: parametersFor({
            name: "deep_union_tool",
            description: "test",
            inputSchema,
          }),
        },
        { type: "toolCall", id: "1", name: "deep_union_tool", arguments: { value: 1.5 } },
      ),
    ).toEqual({ value: 1 });
    expect(
      validateToolArguments(
        {
          name: "deep_union_tool_direct",
          description: "test",
          parameters: normalized as never,
        },
        { type: "toolCall", id: "2", name: "deep_union_tool_direct", arguments: { value: 1.5 } },
      ),
    ).toEqual({ value: 1 });
  });

  it("compacts large nested anyOf unions in linear time", () => {
    const firstHalf = Array.from({ length: 3_000 }, (_, i) => ({
      type: "string",
      description: `choice ${i}`,
    }));
    const secondHalf = Array.from({ length: 3_000 }, (_, i) => ({
      type: "string",
      description: `choice ${i + 3_000}`,
    }));
    const nestedSchema = {
      oneOf: [
        { properties: { choice: { anyOf: firstHalf } } },
        { properties: { choice: { anyOf: secondHalf } } },
      ],
    };
    const wideOneOfSchema = {
      oneOf: Array.from({ length: 10_000 }, (_, i) => ({
        properties: { choice: { type: "string", const: `v${i}` } },
      })),
    };

    expectLinearTime(() => {
      const compactedNested = normalizeOpenAiToolParameters(nestedSchema) as {
        properties: { choice: { anyOf: unknown[] } };
      };
      expect(compactedNested.properties.choice.anyOf).toHaveLength(6_000);

      const compactedWide = normalizeOpenAiToolParameters(wideOneOfSchema) as {
        properties: { choice: { anyOf: unknown[] } };
      };
      expect(compactedWide.properties.choice.anyOf).toHaveLength(10_000);
    });
  });
});

describe("openAiToolParametersNeedNormalization", () => {
  it("returns false for a complete object schema", () => {
    expect(openAiToolParametersNeedNormalization({ type: "object", properties: {} })).toBe(false);
  });

  it("returns true when type or properties are missing or malformed", () => {
    expect(openAiToolParametersNeedNormalization({ type: "object" })).toBe(true);
    expect(openAiToolParametersNeedNormalization({ anyOf: [] })).toBe(true);
    expect(
      openAiToolParametersNeedNormalization({ type: "object", properties: {}, oneOf: [] }),
    ).toBe(true);
    expect(openAiToolParametersNeedNormalization({ type: "object", properties: [] })).toBe(true);
    expect(openAiToolParametersNeedNormalization({ type: "string", properties: {} })).toBe(true);
  });
});

describe("parametersFor OpenAI wire fidelity", () => {
  it("does not close a union after dropping its branch pattern properties", () => {
    const wire = JSON.parse(
      JSON.stringify(
        parametersFor({
          name: "manage_project",
          description: "Manage a project",
          inputSchema: {
            type: "object",
            anyOf: [
              { patternProperties: { "^x": { type: "string" } }, additionalProperties: false },
            ],
          },
        }),
      ),
    );
    expect(wire).not.toHaveProperty("additionalProperties");
  });

  it("preserves an unconstrained boolean union alternative through conversion", () => {
    const wire = JSON.parse(
      JSON.stringify(
        parametersFor({
          name: "manage_project",
          description: "Manage a project",
          inputSchema: {
            type: "object",
            anyOf: [true, { properties: { action: { type: "string" } }, required: ["action"] }],
          },
        }),
      ),
    );
    expect(wire.properties.action).toEqual({});
    expect(wire).not.toHaveProperty("required");
  });

  it("retains gateway-compatible string discriminators for a plain root union", () => {
    const wire = JSON.parse(
      JSON.stringify(
        parametersFor({
          name: "manage_project",
          description: "Manage a project",
          inputSchema: {
            type: "object",
            oneOf: [
              { properties: { action: { const: "start" } }, required: ["action"] },
              { properties: { action: { const: "stop" } }, required: ["action"] },
            ],
          },
        }),
      ),
    );
    expect(wire.properties.action).toEqual({
      anyOf: [
        { type: "string", const: "start", enum: ["start"] },
        { type: "string", const: "stop", enum: ["stop"] },
      ],
    });
  });

  it("preserves root required alongside oneOf without root properties", () => {
    const wire = JSON.parse(
      JSON.stringify(
        parametersFor({
          name: "manage_project",
          description: "Manage a project",
          inputSchema: {
            type: "object",
            required: ["projectId"],
            oneOf: [
              {
                properties: { projectId: { type: "string" }, action: { const: "start" } },
                required: ["action"],
              },
              {
                properties: { projectId: { type: "string" }, action: { const: "stop" } },
                required: ["action"],
              },
            ],
          },
        }),
      ),
    );
    expect(wire).toEqual({
      type: "object",
      properties: {
        projectId: { type: "string" },
        action: {
          anyOf: [
            { type: "string", const: "start", enum: ["start"] },
            { type: "string", const: "stop", enum: ["stop"] },
          ],
        },
      },
      required: ["projectId", "action"],
    });
  });

  it("serializes sibling allOf and oneOf fields with their shared requirements", () => {
    const wire = JSON.parse(
      JSON.stringify(
        parametersFor({
          name: "manage_project",
          description: "Manage a project",
          inputSchema: {
            type: "object",
            allOf: [{ properties: { projectId: { type: "string" } }, required: ["projectId"] }],
            oneOf: [
              { properties: { action: { const: "start" } }, required: ["action"] },
              { properties: { action: { const: "stop" } }, required: ["action"] },
            ],
          },
        }),
      ),
    );
    expect(wire).toEqual({
      type: "object",
      properties: {
        projectId: { type: "string" },
        action: {
          anyOf: [
            { type: "string", const: "start", enum: ["start"] },
            { type: "string", const: "stop", enum: ["stop"] },
          ],
        },
      },
      required: ["projectId", "action"],
    });
  });

  it("serializes root properties together with oneOf fields", () => {
    const wire = JSON.parse(
      JSON.stringify(
        parametersFor({
          name: "manage_project",
          description: "Manage a project",
          inputSchema: {
            type: "object",
            properties: { projectId: { type: "string" } },
            required: ["projectId"],
            oneOf: [
              { properties: { action: { const: "start" } }, required: ["action"] },
              { properties: { action: { const: "stop" } }, required: ["action"] },
            ],
          },
        }),
      ),
    );
    expect(wire).toEqual({
      type: "object",
      properties: {
        projectId: { type: "string" },
        action: {
          anyOf: [
            { type: "string", const: "start", enum: ["start"] },
            { type: "string", const: "stop", enum: ["stop"] },
          ],
        },
      },
      required: ["projectId", "action"],
    });
  });

  it("serializes zero-argument tools with type object and empty properties", () => {
    const tool = builtinAgentTools.find((entry) => entry.name === "list_secrets");
    if (!tool) throw new Error("missing list_secrets");
    const wire = JSON.parse(JSON.stringify(parametersFor(tool))) as {
      type?: unknown;
      properties?: unknown;
    };
    expect(wire.type).toBe("object");
    expect(wire.properties).toEqual({});
  });

  it("serializes request_secret as one object with both destinations and no root union", () => {
    const tool = builtinAgentTools.find((entry) => entry.name === "request_secret");
    if (!tool) throw new Error("missing request_secret");
    const wire = JSON.parse(JSON.stringify(parametersFor(tool))) as Record<string, unknown>;
    expect(wire.type).toBe("object");
    expect(Object.keys(wire.properties as object).sort()).toEqual([
      "connectionId",
      "credential",
      "fields",
      "label",
      "oneTimeCode",
      "purpose",
      "replace",
    ]);
    expect(wire.required).toEqual(["label", "purpose"]);
    expect(wire.additionalProperties).toBe(false);
    for (const key of ["oneOf", "anyOf", "allOf"]) expect(wire).not.toHaveProperty(key);
  });

  it("never sends a root union for any builtin tool", () => {
    for (const tool of builtinAgentTools) {
      const wire = JSON.parse(JSON.stringify(parametersFor(tool))) as Record<string, unknown>;
      for (const key of ["oneOf", "anyOf", "allOf"]) {
        expect(wire, tool.name).not.toHaveProperty(key);
      }
    }
  });

  it("avoids pure nested anyOf wrappers across merged root-union builtin properties", () => {
    const isPureNestedAnyOf = (spec: unknown): boolean =>
      spec != null &&
      typeof spec === "object" &&
      !Array.isArray(spec) &&
      Array.isArray((spec as Record<string, unknown>).anyOf) &&
      ((spec as Record<string, unknown>).anyOf as unknown[]).some(
        (member) =>
          member != null &&
          typeof member === "object" &&
          !Array.isArray(member) &&
          Array.isArray((member as Record<string, unknown>).anyOf) &&
          Object.keys(member as object).length === 1,
      );

    const mergedUnionFields = (schema: Record<string, unknown>): Set<string> => {
      const specs = new Map<string, Set<string>>();
      for (const key of ["oneOf", "anyOf"] as const) {
        const variants = schema[key];
        if (!Array.isArray(variants)) continue;
        for (const variant of variants) {
          if (variant == null || typeof variant !== "object" || Array.isArray(variant)) continue;
          const props = (variant as Record<string, unknown>).properties;
          if (props == null || typeof props !== "object" || Array.isArray(props)) continue;
          for (const [field, spec] of Object.entries(props)) {
            const seen = specs.get(field) ?? new Set<string>();
            seen.add(JSON.stringify(spec) ?? "undefined");
            specs.set(field, seen);
          }
        }
      }
      return new Set([...specs].filter(([, seen]) => seen.size > 1).map(([field]) => field));
    };

    const normalizedBuiltins = builtinAgentTools.filter((tool) =>
      openAiToolParametersNeedNormalization(tool.inputSchema),
    );
    expect(normalizedBuiltins.length).toBeGreaterThan(0);

    let checkedFields = 0;
    for (const tool of normalizedBuiltins) {
      const mergedFields = mergedUnionFields(tool.inputSchema);
      if (mergedFields.size === 0) continue;
      const wire = JSON.parse(JSON.stringify(parametersFor(tool))) as {
        properties?: Record<string, unknown>;
      };
      for (const field of mergedFields) {
        checkedFields += 1;
        expect(isPureNestedAnyOf(wire.properties?.[field]), `${tool.name}.${field}`).toBe(false);
      }
    }
    expect(checkedFields).toBeGreaterThan(0);

    for (const name of ["schedule_create", "create_child_routine"]) {
      const tool = builtinAgentTools.find((entry) => entry.name === name);
      if (!tool) throw new Error(`missing ${name}`);
      const wire = JSON.parse(JSON.stringify(parametersFor(tool))) as {
        properties: Record<string, { anyOf?: Array<Record<string, unknown>> }>;
      };
      for (const field of ["cron", "runAt", "startAt"]) {
        const members = wire.properties[field]?.anyOf ?? [];
        expect(members, `${name}.${field}`).toHaveLength(2);
        expect(members.map((member) => member.type).sort()).toEqual(["null", "string"]);
      }
      const unitMembers = wire.properties.unit?.anyOf ?? [];
      expect(unitMembers.some((member) => member.type === "string" && !("enum" in member))).toBe(
        true,
      );
      expect(unitMembers.some((member) => Array.isArray(member.enum))).toBe(true);
    }
  });
});
