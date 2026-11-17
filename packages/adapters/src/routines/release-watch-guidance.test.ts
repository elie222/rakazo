import { describe, expect, it } from "vitest";
import { normalizeOpenAiToolParameters } from "../runtime/openai-tool-parameters.js";
import { builtinAgentTools } from "../tools/builtin.tool-definition.js";
import { parseConnectorToolArgs } from "../tools/lazy-tool-catalog.js";

describe("release-watch guidance", () => {
  it("exposes an exclusive timing schema for schedule_create", () => {
    const tool = builtinAgentTools.find((entry) => entry.name === "schedule_create");
    const schema = tool?.inputSchema as {
      oneOf?: Array<{ required?: string[]; additionalProperties?: boolean }>;
    };
    expect(schema.oneOf).toHaveLength(6);
    expect(schema.oneOf?.map((branch) => branch.required)).toEqual([
      // cron is optional so a routine only events start matches this branch alone.
      ["name", "prompt"],
      ["name", "prompt", "every", "unit"],
      ["name", "prompt", "runAt"],
      ["name", "prompt", "delayMinutes"],
      ["name", "prompt", "delaySeconds"],
      ["name", "prompt", "watch"],
    ]);
    expect(schema.oneOf?.every((branch) => branch.additionalProperties === false)).toBe(true);
  });

  it("takes events with a repeat or alone, never with a one-time schedule", () => {
    const tool = builtinAgentTools.find((entry) => entry.name === "schedule_create");
    const schema = tool?.inputSchema ?? {};
    const named = { name: "Deploys", prompt: "Summarize the deploy" };
    expect(parseConnectorToolArgs(schema, { ...named, on: { webhook: true } })).toMatchObject({
      on: { webhook: true },
    });
    // A serializer's null for the unused cron is no cron.
    expect(
      parseConnectorToolArgs(schema, { ...named, cron: null, on: { webhook: true } }),
    ).toMatchObject({ on: { webhook: true } });
    expect(
      parseConnectorToolArgs(schema, { ...named, every: 1, unit: "days", on: { chat: "Slack" } }),
    ).toMatchObject({ on: { chat: "Slack" } });
    expect(() =>
      parseConnectorToolArgs(schema, { ...named, delayMinutes: 5, on: { git: true } }),
    ).toThrow(/invalid/i);
    expect(() => parseConnectorToolArgs(schema, { ...named, on: { email: "anyone" } })).toThrow(
      /invalid/i,
    );
  });

  it("accepts null or blank leftover timing fields and rejects a second real method", () => {
    const tool = builtinAgentTools.find((entry) => entry.name === "schedule_create");
    const schema = tool?.inputSchema ?? {};
    expect(
      parseConnectorToolArgs(schema, {
        name: "Morning",
        prompt: "Send the report",
        cron: "0 9 * * *",
        every: null,
        unit: "",
        runAt: "  ",
        delayMinutes: null,
        delaySeconds: "",
      }),
    ).toMatchObject({ name: "Morning", cron: "0 9 * * *" });
    expect(() =>
      parseConnectorToolArgs(schema, {
        name: "Morning",
        prompt: "Send the report",
        cron: "0 9 * * *",
        delayMinutes: 5,
      }),
    ).toThrow(/invalid/i);

    const wire = normalizeOpenAiToolParameters(schema);
    const properties = wire.properties as Record<string, unknown>;
    for (const name of ["cron", "every", "unit", "runAt", "delayMinutes", "delaySeconds"]) {
      expect(JSON.stringify(properties[name])).toContain('"null"');
    }
  });

  it("exposes a read-only task catalog", () => {
    const tool = builtinAgentTools.find((entry) => entry.name === "task_catalog");
    expect(tool?.readOnly).toBe(true);
    expect(tool?.description).toMatch(/source of truth/i);
  });
});
