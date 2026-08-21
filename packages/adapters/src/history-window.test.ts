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
      [
        message("user", "n5"),
        message("bot", "n4"),
        message("user", "n3"),
        message("bot", "n2"),
        message("user", "n1"),
        message("bot", "n0"),
      ],
      { maxBytes: 5, minMessages: 0 },
    );

    expect(result.map((entry) => entry.content)).toEqual(["n4", "n5"]);
  });

  it("truncates the newest stored message", () => {
    const result = buildAgentHistoryWindow(
      [message("bot", "x".repeat(10_000)), message("bot", "n0")],
      { maxBytes: 100_000, minMessages: 0 },
    );

    expect(result).toHaveLength(2);
    expect(result[1]!.content.endsWith("\n\n(truncated)")).toBe(true);
    expect(Buffer.byteLength(result[1]!.content, "utf8")).toBeLessThanOrEqual(4_096);
  });

  it("always keeps the newest message even when the budget is exhausted", () => {
    const result = buildAgentHistoryWindow(
      [message("user", "n5"), message("bot", "n4"), message("user", "n3")],
      { maxBytes: 2, minMessages: 0 },
    );

    expect(result.map((entry) => entry.content)).toEqual(["n5"]);
  });

  it("does not backfill older messages after the newest contiguous window is full", () => {
    const result = buildAgentHistoryWindow(
      [message("user", "n5"), message("bot", "wide"), message("user", "n3")],
      { maxBytes: 3, minMessages: 0 },
    );

    expect(result.map((entry) => entry.content)).toEqual(["n5"]);
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
      [
        message("user", "n5"),
        message("bot", "n4"),
        message("user", "n3"),
        message("bot", "n2"),
        message("user", "n1"),
        message("bot", "n0"),
      ],
      { maxBytes: 5, minMessages: 4 },
    );

    expect(result.map((entry) => entry.content)).toEqual(["n2", "n3", "n4", "n5"]);
  });

  it("returns an empty window for an empty history", () => {
    expect(buildAgentHistoryWindow([])).toEqual([]);
  });

  it("uses the shared attachment summaries instead of serializing raw UI blocks", () => {
    const result = buildAgentHistoryWindow(
      [
        message("user", "newest"),
        {
          role: "bot",
          blocks: [
            {
              kind: "file",
              artifactId: "artifact-1",
              name: "brief.pdf",
              mimeType: "application/pdf",
              size: 42,
            },
          ],
        },
      ],
      { maxBytes: 100_000, minMessages: 0 },
    );

    expect(result[0]!.content).toBe("[file: brief.pdf (application/pdf, 42 bytes)]");
  });
});

function message(role: string, text: string): { role: string; blocks: MessageBlock[] } {
  return { role, blocks: [{ kind: "text", text }] };
}
