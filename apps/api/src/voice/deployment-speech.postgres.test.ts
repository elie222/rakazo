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
    maxRequestMicros: 1_500_000,
    source: "https://pricing.example/speech",
    version: "test-v1",
  };
  const suffix = `${process.pid}-${Date.now()}`;
  const organizations: string[] = [];
  let settings: { modelCreditsEnabled: boolean } | null;
  /** A Space whose organization pays $15 a month, so its speech allowance is $3. */
  async function plannedSpace(spaceId: string) {
    const system = asSystem(db.prisma);
    const organizationId = `fake-speech-organization-${spaceId}-${suffix}`;
    organizations.push(organizationId);
    await system.organization.create({
      data: {
        id: organizationId,
        name: organizationId,
        slug: organizationId,
        createdAt: new Date(),
      },
    });
    await system.space.create({ data: { id: spaceId, organizationId, name: "General" } });
    await system.billingAccount.create({
      data: {
        organizationId,
        customerId: `fake-customer-${organizationId}`,
        status: "active",
        byokTier: "standard",
        byokPriceCents: 1_500,
        byokInterval: "month",
        currentPeriodStartsAt: new Date(Date.now() - 86_400_000),
        currentPeriodEndsAt: new Date(Date.now() + 29 * 86_400_000),
      },
    });
  }
  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    const system = asSystem(db.prisma);
    settings = await system.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { modelCreditsEnabled: true },
    });
    await system.deploymentSettings.upsert({
      where: { id: "default" },
      create: { id: "default", modelCreditsEnabled: true },
      update: { modelCreditsEnabled: true },
    });
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
    const system = asSystem(db.prisma);
    const spaces = await system.space.findMany({
      where: { organizationId: { in: organizations } },
      select: { id: true },
    });
    await system.speechCost.deleteMany({ where: { spaceId: { in: spaces.map((s) => s.id) } } });
    await system.billingAccount.deleteMany({ where: { organizationId: { in: organizations } } });
    await system.space.deleteMany({ where: { organizationId: { in: organizations } } });
    await system.organization.deleteMany({ where: { id: { in: organizations } } });
    if (settings)
      await system.deploymentSettings.update({ where: { id: "default" }, data: settings });
    else await system.deploymentSettings.delete({ where: { id: "default" } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });
  it.each(["synthesize", "transcribe"] as const)(
    "admits an affordable %s even when the other operation exceeds the remaining allowance",
    async (operation) => {
      const tenant = {
        userId: `fake-speech-${operation}`,
        spaceId: `fake-space-${operation}`,
      } as Actor;
      const system = asSystem(db.prisma);
      await plannedSpace(tenant.spaceId);
      const deployment = deps.env!.deploymentVoice!;
      const scoped = {
        ...deps,
        env: {
          ...deps.env,
          deploymentVoice: {
            ...deployment,
            pricing: {
              ...deployment.pricing,
              synthesize: { ...deployment.pricing.synthesize, maxRequestMicros: 5_000_000 },
              transcribe: { ...deployment.pricing.transcribe, maxRequestMicros: 5_000_000 },
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
    await plannedSpace(actor.spaceId);
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
        accountedMicros: 1_500_000n,
      });
    expect(await system.modelCreditEntry.count()).toBe(0);
  });
});
