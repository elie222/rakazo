import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { buildAgentHistoryWindow } from "./history-window.js";

describe("agent history window", () => {
  it("orders newest-first input oldest-first and maps roles", () => {
    const result = buildAgentHistoryWindow(
      [
        message("user", "newest user"),
        message("system", "middle system"),
        message("bot", "oldest bot"),
      ],
      { maxBytes: 1_000_000, minMessages: 0 },
    );

    expect(result.map((entry) => entry.role)).toEqual(["assistant", "system", "user"]);
    expect(result.map((entry) => entry.content)).toEqual([
      "oldest bot",
      "middle system",
      "newest user",
    ]);
  });

  it("drops oldest messages once the byte budget is exceeded", () => {
    const result = buildAgentHistoryWindow(
      [message("user", "n5"), message("bot", "n4"), message("user", "n3"), message("bot", "n2"), message("user", "n1"), message("bot", "n0")],
      { maxBytes: 5, minMessages: 0 },
    );

    expect(result.map((entry) => entry.content)).toEqual(["n3", "n4", "n5"]);
  });

  it("always keeps the newest message in full even when it exceeds the budget", () => {
    const huge = "x".repeat(10_000);
    const result = buildAgentHistoryWindow(
      [message("user", huge), message("bot", "n0")],
      { maxBytes: 100, minMessages: 0 },
    );

    expect(result).toHaveLength(2);
    expect(result[1]).toEqual({ role: "user", content: huge });
  });

  it("truncates oversized messages to a headline with a marker", () => {
    const result = buildAgentHistoryWindow(
      [message("user", "newest"), message("bot", "m".repeat(10_000))],
      { maxBytes: 100_000, minMessages: 0, maxMessageBytes: 4_096 },
    );

    expect(result[0]!.role).toBe("assistant");
    expect(result[0]!.content.endsWith("\n\n(truncated)")).toBe(true);
    expect(Buffer.byteLength(result[0]!.content, "utf8")).toBeLessThanOrEqual(4_096);
    expect(result[1]).toEqual({ role: "user", content: "newest" });
  });

  it("does not split UTF-8 characters when truncating", () => {
    const result = buildAgentHistoryWindow(
      [message("user", "newest"), message("bot", "🙂".repeat(2_000))],
      { maxBytes: 100_000, minMessages: 0, maxMessageBytes: 100 },
    );

    expect(result[0]!.content).not.toContain("�");
    expect(result[0]!.content.startsWith("🙂".repeat(21))).toBe(true);
    expect(result[0]!.content.endsWith("(truncated)")).toBe(true);
  });

  it("keeps at least the minimum message floor even over budget", () => {
    const result = buildAgentHistoryWindow(
      [message("user", "n5"), message("bot", "n4"), message("user", "n3"), message("bot", "n2"), message("user", "n1"), message("bot", "n0")],
      { maxBytes: 5, minMessages: 3 },
    );

    expect(result.length).toBeGreaterThanOrEqual(4);
    expect(result.map((entry) => entry.content)).toEqual(["n2", "n3", "n4", "n5"]);
  });

  it("returns an empty window for an empty history", () => {
    expect(buildAgentHistoryWindow([])).toEqual([]);
  });

  it("serializes non-text blocks as JSON", () => {
    const result = buildAgentHistoryWindow(
      [
        message("user", "newest"),
        { role: "bot", blocks: [{ kind: "card", lines: [{ k: "a", v: "b" }] }] },
      ],
      { maxBytes: 100_000, minMessages: 0 },
    );

    expect(result[0]!.content).toContain('"kind":"card"');
  });
});

function message(role: string, text: string): { role: string; blocks: MessageBlock[] } {
  return { role, blocks: [{ kind: "text", text }] };
}