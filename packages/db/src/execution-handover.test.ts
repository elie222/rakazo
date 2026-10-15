import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { resolveExecutionHandover } from "./execution-handover.js";

const scope = { id: "run", spaceId: "space", userId: "user", botId: "bot", threadId: "thread" };
const snapshot = (profileId: string, harness: "claude" | "codex" = "claude") => ({
  profileId,
  revision: 1,
  spaceId: "space",
  userId: "user",
  harness,
  provider: "provider",
  credentialId: "credential",
  credentialSecretId: "secret",
  protocol: "anthropic",
  endpoint: "https://example.com",
  modelId: "model",
  runtimeVersion: "test",
  computerId: null,
});
function fixture(current: unknown, previous: unknown, exists = true) {
  const findFirst = vi
    .fn()
    .mockResolvedValueOnce({
      startedAt: new Date("2026-10-15T00:00:00Z"),
      executionProfileSnapshot: current,
    })
    .mockResolvedValueOnce(exists ? { executionProfileSnapshot: previous } : null);
  return { findFirst, prisma: { run: { findFirst } } as unknown as PrismaClient };
}

describe("canonical execution handover", () => {
  it("preserves ordinary same-profile continuity", async () => {
    const { prisma } = fixture(snapshot("a"), snapshot("a"));
    expect(await resolveExecutionHandover(prisma, scope)).toBeNull();
  });
  it("does not invent a handover for the first turn", async () => {
    const { prisma } = fixture(snapshot("a"), null, false);
    expect(await resolveExecutionHandover(prisma, scope)).toBeNull();
  });
  it("describes native profile changes without importing private histories", async () => {
    const { prisma, findFirst } = fixture(snapshot("b", "codex"), snapshot("a"));
    const result = await resolveExecutionHandover(prisma, scope);
    expect(result).toMatchObject({ previousHarness: "claude", currentHarness: "codex" });
    expect(result?.summary).toContain("Native session state is not transferred");
    expect(findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "user",
          spaceId: "space",
          botId: "bot",
          threadId: "thread",
          id: { not: "run" },
        }),
        select: { executionProfileSnapshot: true },
      }),
    );
  });
  it("marks a changed account/profile even when the harness stays the same", async () => {
    const { prisma } = fixture(snapshot("b"), snapshot("a"));
    expect(await resolveExecutionHandover(prisma, scope)).not.toBeNull();
  });
  it("supports transitions to and from inherited Pi", async () => {
    expect(
      await resolveExecutionHandover(fixture(null, snapshot("a")).prisma, scope),
    ).toMatchObject({ currentHarness: "pi" });
    expect(
      await resolveExecutionHandover(fixture(snapshot("a"), null).prisma, scope),
    ).toMatchObject({ previousHarness: "pi" });
  });
});
