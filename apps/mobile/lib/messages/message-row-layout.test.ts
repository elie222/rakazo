import { describe, expect, it } from "vitest";
import type { MobileMessage } from "../api/mobile-types";
import { messageRowLayout } from "./message-row-layout";

const layout = (blocks: MobileMessage["blocks"]) =>
  messageRowLayout(blocks, { inGroup: false, columnWidth: 390 });

describe("messageRowLayout", () => {
  it("lets a routine row span the column so its line centers", () => {
    const row = layout([{ kind: "routine_event", change: "created", name: "Morning joke" }]);
    expect(row.width).toBe("100%");
    expect(row.menuFullWidth).toBe(true);
  });

  it("keeps an ordinary text bubble to its content", () => {
    expect(layout([{ kind: "text", text: "Hi" }]).menuFullWidth).toBe(false);
  });
});
