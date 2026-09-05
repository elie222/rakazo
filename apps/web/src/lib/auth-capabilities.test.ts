import { describe, expect, it } from "vitest";
import { safeLoginReturn } from "./auth-capabilities";

describe("login return path", () => {
  it("preserves app routes but cannot navigate outside the application", () => {
    expect(safeLoginReturn("/app/bot-one?view=files")).toBe("/app/bot-one?view=files");
    for (const target of [
      null,
      "https://evil.test",
      "//evil.test",
      "/app\\evil.test",
      "/application",
      "/login",
      "/app\r\nLocation:evil",
    ])
      expect(safeLoginReturn(target)).toBe("/app");
  });
});
