import { describe, expect, it } from "vitest";
import { appContract } from "../rpc/app-contract.js";
import { CreateScratchpadItemInput } from "./scratchpad.js";

describe("scratchpad titles", () => {
  it("refuses a blank title on create", () => {
    expect(CreateScratchpadItemInput.safeParse({ botId: "bot-1", title: "   " }).success).toBe(
      false,
    );
  });

  it("stores a create title without surrounding spaces", () => {
    const parsed = CreateScratchpadItemInput.parse({ botId: "bot-1", title: "  Notes  " });
    expect(parsed.title).toBe("Notes");
  });

  it("refuses a blank title on rename and trims a real one", () => {
    const schema = appContract.scratchpad.update["~orpc"].inputSchema;
    if (!schema) throw new Error("update has no input schema");
    expect(schema.safeParse({ itemId: "item-1", title: "   " }).success).toBe(false);
    const parsed = schema.safeParse({ itemId: "item-1", title: "  Notes  " });
    expect(parsed.success && parsed.data.title).toBe("Notes");
  });
});
