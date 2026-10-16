import { describe, expect, it } from "vitest";
import { serializeToolResult } from "./pi-runtime.js";

describe("serializeToolResult", () => {
  const skill = {
    name: "large-skill",
    description: "Large skill",
    source: "user",
    readOnly: false,
    content: `---\nname: large-skill\n---\n${"1. Step kept for skill_update.\n".repeat(600)}`,
  };

  it.each(["current", "retrieval"] as const)(
    "returns a large skill read verbatim with the %s strategy",
    (strategy) => {
      const text = serializeToolResult(skill, strategy, "skill_read", { name: skill.name });
      expect(text.length).toBeGreaterThan(12_000);
      expect(JSON.parse(text)).toEqual(skill);
    },
  );

  it("still bounds other large tool results", () => {
    const text = serializeToolResult({ output: "x".repeat(20_000) }, "current", "shell", {});
    expect(text.length).toBeLessThan(20_000);
  });
});
