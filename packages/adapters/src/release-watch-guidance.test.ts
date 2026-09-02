import { describe, expect, it } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";

describe("release-watch guidance", () => {
  it("tells schedule_create prompts to name plugin tools instead of browsing", () => {
    const tool = builtinAgentTools.find((entry) => entry.name === "schedule_create");
    expect(tool).toBeTruthy();
    const prompt = (
      tool?.inputSchema as { properties?: { prompt?: { description?: string } } } | undefined
    )?.properties?.prompt;
    expect(prompt?.description ?? "").toContain("GITHUB_LIST_RELEASES");
    expect(prompt?.description ?? "").toMatch(/Prefer plugin tools over computer browser/i);
  });
});
