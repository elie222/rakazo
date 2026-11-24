import type { ToolCall } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { describe, expect, it } from "vitest";
import { parametersFor } from "./pi-runtime-tool-parameters.js";

function toolFor(inputSchema: Record<string, unknown>) {
  const tool = { name: "ref_tool", description: "Uses refs", inputSchema };
  const parameters = parametersFor(tool);
  return {
    wire: JSON.parse(JSON.stringify(parameters)),
    validate: (args: ToolCall["arguments"]) =>
      validateToolArguments(
        { ...tool, parameters },
        { type: "toolCall", id: "ref-test", name: tool.name, arguments: args },
      ),
  };
}

const point = {
  type: "object",
  properties: { x: { type: "number" }, y: { type: "number" } },
  required: ["x", "y"],
};

describe("local $ref inputs", () => {
  it("keeps the target shape, enum and array items of $defs references", () => {
    const { wire, validate } = toolFor({
      type: "object",
      $defs: { Pt: point, Color: { type: "string", enum: ["red", "blue"] } },
      properties: {
        pt: { $ref: "#/$defs/Pt" },
        color: { $ref: "#/$defs/Color" },
        pts: { type: "array", items: { $ref: "#/$defs/Pt" } },
      },
      required: ["pt"],
    });
    expect(JSON.stringify(wire)).not.toContain("$ref");
    expect(wire.$defs).toBeUndefined();
    const valid = { pt: { x: 1, y: 2 }, color: "red", pts: [{ x: 3, y: 4 }] };
    expect(validate(valid)).toEqual(valid);
    expect(() => validate({ ...valid, color: "green" })).toThrow();
    expect(() => validate({ ...valid, pts: [{ x: 1 }] })).toThrow();
    expect(() => validate({ pt: "text" })).toThrow();
    expect(() => validate({ color: "red" })).toThrow();
  });

  it("keeps the description of an allOf-wrapped reference", () => {
    const { wire, validate } = toolFor({
      type: "object",
      $defs: { Color: { type: "string", enum: ["red", "blue"] } },
      properties: { color: { allOf: [{ $ref: "#/$defs/Color" }], description: "Pick one" } },
    });
    expect(wire.properties.color.description).toBe("Pick one");
    expect(validate({ color: "blue" })).toEqual({ color: "blue" });
    expect(() => validate({ color: "green" })).toThrow();
  });

  it("accepts an optional reference as anyOf with null", () => {
    const { validate } = toolFor({
      type: "object",
      $defs: { Pt: point },
      properties: { pt: { anyOf: [{ $ref: "#/$defs/Pt" }, { type: "null" }], default: null } },
    });
    expect(validate({ pt: null })).toEqual({ pt: null });
    expect(validate({ pt: { x: 1, y: 2 } })).toEqual({ pt: { x: 1, y: 2 } });
    expect(() => validate({ pt: "text" })).toThrow();
  });

  it("resolves draft-07 definitions", () => {
    const { wire, validate } = toolFor({
      type: "object",
      definitions: { Pt: point },
      properties: { pt: { $ref: "#/definitions/Pt", description: "A point" } },
      required: ["pt"],
    });
    expect(wire.properties.pt.description).toBe("A point");
    expect(validate({ pt: { x: 1, y: 2 } })).toEqual({ pt: { x: 1, y: 2 } });
    expect(() => validate({ pt: { x: 1 } })).toThrow();
  });

  it("terminates on a recursive schema and still checks the first levels", () => {
    const { validate } = toolFor({
      type: "object",
      $defs: {
        Node: {
          type: "object",
          properties: {
            name: { type: "string" },
            children: { type: "array", items: { $ref: "#/$defs/Node" } },
          },
          required: ["name"],
        },
      },
      properties: { root: { $ref: "#/$defs/Node" } },
      required: ["root"],
    });
    const tree = { root: { name: "a", children: [{ name: "b", children: [{ name: "c" }] }] } };
    expect(validate(tree)).toEqual(tree);
    expect(() => validate({ root: { children: [] } })).toThrow();
  });

  it("leaves a remote reference as it was", () => {
    const { wire } = toolFor({
      type: "object",
      properties: { remote: { $ref: "https://example.com/schema.json" } },
    });
    expect(wire.properties.remote.type).toBe("string");
  });
});

describe("local $ref inputs named like keywords", () => {
  it("resolves a reference inside a property called default", () => {
    const { validate } = toolFor({
      type: "object",
      $defs: { Pt: point },
      properties: { default: { $ref: "#/$defs/Pt" } },
    });
    expect(() => validate({ default: "text" })).toThrow();
  });
});

describe("local $ref inputs that expand too far", () => {
  it("degrades a schema whose references multiply past the size limit", () => {
    const big = {
      type: "object",
      properties: { text: { type: "string", description: "x".repeat(20_000) } },
    };
    const { wire } = toolFor({
      type: "object",
      $defs: { Big: big },
      properties: Object.fromEntries(
        Array.from({ length: 50 }, (_, index) => [`field${index}`, { $ref: "#/$defs/Big" }]),
      ),
    });
    expect(wire.properties).toEqual({});
  });
});
