import { describe, expect, it } from "vitest";
import type { MobileMessage } from "./mobile-types";
import { searchThreadMessages, stepSearchIndex } from "./thread-search";

function message(id: string, text: string, role: MobileMessage["role"] = "bot"): MobileMessage {
  return {
    id,
    role,
    blocks: [{ kind: "text", text }],
  } as MobileMessage;
}

describe("thread search", () => {
  it("matches case-insensitively in reading order", () => {
    const messages = [
      message("m1", "Clear the disk cache"),
      message("m2", "Nothing to do here"),
      message("m3", "The DISK is 87% full"),
      message("m4", "disk space recovered", "user"),
    ];
    expect(searchThreadMessages(messages, "disk").map((item) => item.id)).toEqual([
      "m1",
      "m3",
      "m4",
    ]);
    expect(searchThreadMessages(messages, "DISK").map((item) => item.id)).toEqual([
      "m1",
      "m3",
      "m4",
    ]);
  });

  it("returns nothing for an empty query or no match", () => {
    const messages = [message("m1", "Hello")];
    expect(searchThreadMessages(messages, "")).toEqual([]);
    expect(searchThreadMessages(messages, "   ")).toEqual([]);
    expect(searchThreadMessages(messages, "bye")).toEqual([]);
  });

  it("wraps the step index around the hit list", () => {
    expect(stepSearchIndex(0, 3, 1)).toBe(1);
    expect(stepSearchIndex(2, 3, 1)).toBe(0);
    expect(stepSearchIndex(0, 3, -1)).toBe(2);
    expect(stepSearchIndex(-1, 3, 1)).toBe(0);
    expect(stepSearchIndex(-1, 0, 1)).toBe(-1);
  });
});
