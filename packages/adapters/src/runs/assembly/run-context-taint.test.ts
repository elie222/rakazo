import { describe, expect, it } from "vitest";
import type { RunContext } from "./run-context.js";
import { isRunTaintedBeyondOwnComputer, markReadOutsideContent } from "./run-context.js";

function context(outsideMessage: () => boolean) {
  return {
    runId: "run-1",
    state: {},
    deps: { prisma: { attempt: { count: async () => 1 } } },
    trust: { receivedOutsideMessage: async () => outsideMessage() },
  } as unknown as RunContext;
}

describe("isRunTaintedBeyondOwnComputer", () => {
  it("still notices an outside message claimed after the owner's computer output", async () => {
    let claimed = false;
    const ctx = context(() => claimed);
    markReadOutsideContent(ctx, "shell output", { ownComputer: true });
    expect(await isRunTaintedBeyondOwnComputer(ctx)).toBe(false);
    claimed = true;
    expect(await isRunTaintedBeyondOwnComputer(ctx)).toBe(true);
  });
});
