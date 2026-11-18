import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "../database/client.js";
import { createDb } from "../database/client.js";
import { asSystem, runAsSystem, runAsTenant } from "../database/row-security.js";
import { admitSpeech, confirmSpeechCost, settleSpeech } from "./costs.js";

const suite = process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;
suite("operator speech costs (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  const actor = { userId: "speech-test-account", spaceId: "speech-test-space" };
  const price = {
    model: "speech-model",
    unit: "characters" as const,
    microsPerUnit: 2,
    maxRequestMicros: 100,
    source: "https://pricing.example/speech",
    version: "test-v1",
  };
  const admit = () =>
    runAsTenant(actor, () => admitSpeech(db.prisma, actor, "test-provider", "synthesize", price));
  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
    system = asSystem(db.prisma);
  });
  beforeEach(async () => {
    await system.$executeRaw`DELETE FROM speech_costs`;
    await system.$executeRaw`DELETE FROM speech_allowances`;
    await system.$executeRaw`INSERT INTO speech_allowances ("userId", "limitMicros", "expiresAt")
      VALUES (${actor.userId}, 300, now() + interval '1 day')`;
  });
  afterAll(async () => {
    await db.prisma.$disconnect();
    await db.pool.end();
  });
  async function used() {
    const [row] = await system.$queryRaw<
      Array<{ usedMicros: bigint }>
    >`SELECT "usedMicros" FROM speech_allowances`;
    return row!.usedMicros;
  }
  it("refuses direct tenant writes to operator grants and cost evidence", async () => {
    const id = await admit();
    await runAsTenant(actor, async () => {
      expect(
        await db.prisma
          .$executeRaw`UPDATE speech_allowances SET "limitMicros" = 999999 WHERE "userId" = ${actor.userId}`,
      ).toBe(0);
      expect(await db.prisma.$executeRaw`DELETE FROM speech_costs WHERE id = ${id}`).toBe(0);
      await expect(
        db.prisma
          .$executeRaw`INSERT INTO speech_allowances ("userId", "limitMicros", "expiresAt") VALUES ('forged-account', 999999, now() + interval '1 day')`,
      ).rejects.toThrow();
    });
    expect(await used()).toBe(100n);
    expect(await system.speechCost.count()).toBe(1);
  });
  it("admits only the available allowance under concurrent database requests", async () => {
    const results = await Promise.allSettled(Array.from({ length: 10 }, admit));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(await used()).toBe(300n);
    expect(await system.speechCost.count()).toBe(3);
  });
  it("settles once, records attribution and provenance, and confirms actual cost separately", async () => {
    const id = await admit();
    const usage = {
      model: price.model,
      unit: price.unit,
      units: 10,
    };
    await runAsTenant(actor, () => settleSpeech(db.prisma, id, usage, "fake-request"));
    await runAsTenant(actor, () => settleSpeech(db.prisma, id, usage, "fake-request"));
    expect(await used()).toBe(20n);
    expect(await system.speechCost.findUnique({ where: { id } })).toMatchObject({
      ...actor,
      state: "estimated",
      costMicros: 20n,
      units: 10,
      pricingVersion: "test-v1",
      providerRequestId: "fake-request",
    });
    const evidence = {
      costMicros: 15n,
      source: "invoice-export-v1",
      reference: "fake-invoice-line",
    };
    await runAsSystem("test billing evidence", () => confirmSpeechCost(db.prisma, id, evidence));
    await runAsSystem("test billing evidence", () => confirmSpeechCost(db.prisma, id, evidence));
    await expect(
      runAsSystem("test conflicting evidence", () =>
        confirmSpeechCost(db.prisma, id, { ...evidence, source: "different-source" }),
      ),
    ).rejects.toMatchObject({
      kind: "CONFLICT",
      message: "Speech cost already confirmed with different evidence",
    });
    expect(await used()).toBe(15n);
    expect((await system.speechCost.findUniqueOrThrow({ where: { id } })).state).toBe("confirmed");
    await expect(
      runAsTenant(actor, () => confirmSpeechCost(db.prisma, id, evidence)),
    ).rejects.toMatchObject({
      kind: "FORBIDDEN",
      message: "Speech reconciliation requires system context",
    });
  });
  it("classifies cross-account and cross-Space speech access as forbidden", async () => {
    const id = await admit();
    for (const other of [
      { ...actor, userId: "another-account" },
      { ...actor, spaceId: "another-space" },
    ]) {
      await expect(
        runAsTenant(other, () =>
          admitSpeech(db.prisma, actor, "test-provider", "synthesize", price),
        ),
      ).rejects.toMatchObject({ kind: "FORBIDDEN" });
      await expect(
        runAsTenant(other, () =>
          settleSpeech(db.prisma, id, { model: price.model, unit: price.unit, units: 1 }),
        ),
      ).rejects.toMatchObject({ kind: "FORBIDDEN" });
    }
    expect(await used()).toBe(100n);
    expect(await system.speechCost.findUniqueOrThrow({ where: { id } })).toMatchObject({
      state: "pending",
      accountedMicros: 100n,
    });
  });
  it("classifies invalid reconciliation evidence and missing cost rows", async () => {
    await expect(
      runAsSystem("test invalid evidence", () =>
        confirmSpeechCost(db.prisma, "missing-speech-call", {
          costMicros: -1n,
          source: "fixture",
          reference: "fixture",
        }),
      ),
    ).rejects.toMatchObject({ kind: "BAD_REQUEST" });
    await expect(
      runAsSystem("test missing speech record", () =>
        confirmSpeechCost(db.prisma, "missing-speech-call", {
          costMicros: 0n,
          source: "fixture",
          reference: "fixture",
        }),
      ),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
  });
  it.each([
    { rate: 0.07, units: 100, expected: 7n },
    { rate: 0.07, units: 101, expected: 8n },
    { rate: 0.7, units: 0.1, expected: 1n },
    { rate: 1e-7, units: 1e7, expected: 1n },
  ])("settles decimal pricing exactly ($rate × $units)", async ({ rate, units, expected }) => {
    const id = await runAsTenant(actor, () =>
      admitSpeech(db.prisma, actor, "test-provider", "synthesize", {
        ...price,
        microsPerUnit: rate,
      }),
    );
    await runAsTenant(actor, () =>
      settleSpeech(db.prisma, id, { model: price.model, unit: price.unit, units }),
    );
    expect(await used()).toBe(expected);
    expect(await system.speechCost.findUniqueOrThrow({ where: { id } })).toMatchObject({
      state: "estimated",
      costMicros: expected,
      accountedMicros: expected,
    });
  });

  it("retains uncertain reservations and recovers only with evidence, including a zero charge", async () => {
    const pending = await admit();
    const unresolved = await admit();
    await runAsTenant(actor, () => settleSpeech(db.prisma, unresolved, undefined));
    expect(await used()).toBe(200n);
    expect((await system.speechCost.findUniqueOrThrow({ where: { id: pending } })).state).toBe(
      "pending",
    );
    await runAsSystem("test no-charge evidence", () =>
      confirmSpeechCost(db.prisma, pending, {
        costMicros: 0n,
        source: "provider-export",
        reference: "fake-no-charge",
      }),
    );
    expect(await used()).toBe(100n);
  });
  it("keeps mismatched and mixed token usage unresolved with evidence intact", async () => {
    const mismatched = await admit();
    await runAsTenant(actor, () =>
      settleSpeech(db.prisma, mismatched, { model: "different-model", unit: "seconds", units: 2 }),
    );
    const tokenPrice = { ...price, unit: "tokens" as const };
    const tokenId = await runAsTenant(actor, () =>
      admitSpeech(db.prisma, actor, "test-provider", "transcribe", tokenPrice),
    );
    await runAsTenant(actor, () =>
      settleSpeech(
        db.prisma,
        tokenId,
        { model: price.model, unit: "tokens", units: 40, inputTokens: 30, outputTokens: 10 },
        "fake-token-request",
      ),
    );
    expect(await used()).toBe(200n);
    const row = await system.speechCost.findUniqueOrThrow({ where: { id: tokenId } });
    expect(row).toMatchObject({
      state: "unresolved",
      providerRequestId: "fake-token-request",
      billableUnits: { inputTokens: 30, outputTokens: 10 },
    });
  });
  it("counts observed overruns and refuses expired, missing and other-account allowances", async () => {
    const id = await admit();
    await runAsTenant(actor, () =>
      settleSpeech(db.prisma, id, { model: price.model, unit: price.unit, units: 200 }),
    );
    expect(await used()).toBe(400n);
    await expect(admit()).rejects.toThrow("allowance unavailable");
    await system.$executeRaw`UPDATE speech_allowances SET "usedMicros" = 0, "expiresAt" = now() - interval '1 second'`;
    await expect(admit()).rejects.toThrow("allowance unavailable");
    await expect(
      runAsTenant({ ...actor, userId: "another-account" }, () =>
        admitSpeech(
          db.prisma,
          { ...actor, userId: "another-account" },
          "test-provider",
          "synthesize",
          price,
        ),
      ),
    ).rejects.toThrow();
    expect(await system.speechCost.count()).toBe(1);
  });
});
