import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const thread = readFileSync(new URL("../app/thread.tsx", import.meta.url), "utf8");

describe("cross-space child bot navigation", () => {
  it("forwards the destination through the stable row-action wrapper", () => {
    expect(thread.includes("openBot: (...args) => rowActionsRef.current.openBot(...args)")).toBe(
      true,
    );
    expect(
      thread.includes('onOpenBot(special.botId ?? "", special.name ?? t("Bot"), special.spaceId)'),
    ).toBe(true);
  });

  it("carries the destination into the native thread route", () => {
    expect(thread).toContain("(id: string, botName: string, spaceId?: string)");
    expect(thread).toContain(
      "params: { botId: id, name: botName, ...(spaceId ? { spaceId } : {}) }",
    );
  });
});
