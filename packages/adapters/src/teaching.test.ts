import { describe, expect, it } from "vitest";
import { inferScript } from "./scripted-runtime.js";

describe("inferScript taught skills", () => {
  it("recognizes run taught skill prompts", () => {
    const script = inferScript("Run taught skill: Export weekly CRM list\nThis is a safe test");
    expect(script[0]?.assistant?.toLowerCase()).toContain("taught skill");
  });

  it("recognizes run {name} user messages", () => {
    const script = inferScript("run Export weekly CRM list");
    expect(script[0]?.assistant?.toLowerCase()).toContain("playbook");
  });
});
