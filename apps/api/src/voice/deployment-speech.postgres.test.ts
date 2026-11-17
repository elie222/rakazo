import type { Actor } from "@rakazo/contracts";
import { asSystem, createDb, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { VoiceDeps } from "../calls/voice.js";
import { effectiveVoiceStatus, synthesizeVoice, transcribeVoice } from "../calls/voice.js";
import { deploymentVoiceFromEnv } from "./deployment-config.js";

const suite = process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;
suite("hosted speech dispatch (PostgreSQL, offline adapter)", () => {
  let db: ReturnType<typeof createDb>;
  let deps: VoiceDeps;
  const actor = { userId: "fake-speech-user", spaceId: "fake-speech-space" } as Actor;
  const price = {
    model: "fake-model",
    unit: "characters",
    microsPerUnit: 1,
    maxRequestMicros: 100,
    source: "https://pricing.example/speech",
    version: "test-v1",
  };
  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
    deps = {
      prisma: db.prisma,
      secrets: {} as VoiceDeps["secrets"],
      env: {
        deploymentVoice: deploymentVoiceFromEnv(
          JSON.stringify({
            provider: "scripted",
            allowUnmeteredUsage: true,
            voiceId: "alloy-test",
            connection: { plaintext: "fake-server-key" },
            pricing: { synthesize: price, transcribe: price },
          }),
        ),
      },
    };
  });
  afterAll(async () => {
    await db.prisma.$disconnect();
    await db.pool.end();
  });
  it.each(["synthesize", "transcribe"] as const)(
    "admits an affordable %s even when the other operation exceeds the remaining grant",
    async (operation) => {
      const tenant = {
        userId: `fake-speech-${operation}`,
        spaceId: `fake-space-${operation}`,
      } as Actor;
      const system = asSystem(db.prisma);
      await system.$executeRaw`INSERT INTO speech_allowances ("userId", "limitMicros", "expiresAt")
      VALUES (${tenant.userId}, 50, now() + interval '1 day')`;
      const deployment = deps.env!.deploymentVoice!;
      const scoped = {
        ...deps,
        env: {
          ...deps.env,
          deploymentVoice: {
            ...deployment,
            pricing: {
              ...deployment.pricing,
              [operation]: { ...deployment.pricing[operation], maxRequestMicros: 10 },
            },
          },
        },
      };
      await runAsTenant(tenant, async () => {
        expect(await effectiveVoiceStatus(scoped, tenant)).toMatchObject({
          ready: operation === "synthesize",
          transcribe: operation === "transcribe",
        });
        if (operation === "synthesize")
          await synthesizeVoice(scoped, tenant, { text: "Synthetic sample" });
        else
          await transcribeVoice(scoped, tenant, {
            audio: new Uint8Array([1]),
            mimeType: "audio/wav",
          });
      });
      expect(await system.speechCost.findMany({ where: { userId: tenant.userId } })).toMatchObject([
        { operation, reservedMicros: 10n },
      ]);
    },
  );
  it("uses the default without member keys, admits before dispatch, and retains unknown costs", async () => {
    const system = asSystem(db.prisma);
    await system.$executeRaw`INSERT INTO speech_allowances ("userId", "limitMicros", "expiresAt")
      VALUES (${actor.userId}, 200, now() + interval '1 day')`;
    await runAsTenant(actor, async () => {
      expect(await effectiveVoiceStatus(deps, actor)).toMatchObject({
        ready: true,
        transcribe: true,
      });
      expect(
        (await synthesizeVoice(deps, actor, { text: "Synthetic sample", callId: "fake-call" }))
          .mimeType,
      ).toBe("audio/mpeg");
      expect(
        (
          await transcribeVoice(deps, actor, {
            audio: new Uint8Array([1]),
            mimeType: "audio/wav",
            callId: "fake-call",
          })
        ).text,
      ).toBeTruthy();
      await expect(synthesizeVoice(deps, actor, { text: "Over allowance" })).rejects.toThrow(
        "Add a voice provider key",
      );
    });
    const costs = await system.speechCost.findMany({ where: { userId: actor.userId } });
    expect(costs).toHaveLength(2);
    expect(costs.map((row) => row.operation).sort()).toEqual(["synthesize", "transcribe"]);
    for (const row of costs)
      expect(row).toMatchObject({
        userId: actor.userId,
        spaceId: actor.spaceId,
        callId: "fake-call",
        state: "unresolved",
        accountedMicros: 100n,
      });
    expect(await system.modelCreditEntry.count()).toBe(0);
  });
});
