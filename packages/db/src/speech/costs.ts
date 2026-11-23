import { randomUUID } from "node:crypto";
import type { VoiceUsage } from "@rakazo/adapter-kit";
import { ClientError } from "@rakazo/core";
import { speechAllowancePlan } from "../billing/sandbox-allowance.js";
import type { PrismaClient } from "../database/client.js";
import { currentDbContext, runAsSystem } from "../database/row-security.js";

export interface SpeechPrice {
  model: string;
  unit: "characters" | "seconds" | "tokens";
  microsPerUnit: number;
  maxRequestMicros: number;
  source: string;
  version: string;
}

/**
 * Micros the space's organization may still spend on deployment-funded speech this period, or
 * null when the deployment does not limit it. Every reservation and cost recorded for any of the
 * organization's Spaces since the period began counts.
 */
export async function remainingSpeechAllowance(
  prisma: Pick<PrismaClient, "space" | "deploymentSettings" | "organization" | "speechCost">,
  spaceId: string,
  now = new Date(),
): Promise<bigint | null> {
  return runAsSystem("speech allowance across an organization's Spaces", async () => {
    const space = await prisma.space.findUnique({
      where: { id: spaceId },
      select: { organizationId: true },
    });
    if (!space) return 0n;
    const plan = await speechAllowancePlan(prisma, space.organizationId, now);
    if (!plan) return null;
    const used = await prisma.speechCost.aggregate({
      where: { organizationId: space.organizationId, createdAt: { gte: plan.since } },
      _sum: { accountedMicros: true },
    });
    return plan.limitMicros - (used._sum.accountedMicros ?? 0n);
  });
}

/** A reservation survives a crash/cancel: only evidence of no charge may release it. */
export async function admitSpeech(
  prisma: Pick<PrismaClient, "$transaction">,
  scope: { userId: string; spaceId: string; callId?: string },
  provider: string,
  operation: "synthesize" | "transcribe",
  price: SpeechPrice,
) {
  const context = currentDbContext();
  if (!context) throw new Error("Speech admission requires the owning account context");
  if (
    context.kind === "tenant" &&
    (context.userId !== scope.userId || context.spaceId !== scope.spaceId)
  )
    throw new ClientError("FORBIDDEN", "Speech admission requires the owning account context");
  const id = randomUUID();
  await runAsSystem("Admit operator-funded speech for the authenticated account", () =>
    prisma.$transaction(async (tx) => {
      // One organization's admissions run one at a time, so concurrent requests cannot overspend.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(
        'speech:' || (SELECT "organizationId" FROM spaces WHERE id = ${scope.spaceId}), 0))::text`;
      const remaining = await remainingSpeechAllowance(tx, scope.spaceId);
      if (remaining !== null && remaining < BigInt(price.maxRequestMicros))
        throw new ClientError("TOO_MANY_REQUESTS", "Speech allowance unavailable.");
      await tx.$executeRaw`
      INSERT INTO speech_costs
        (id, "userId", "spaceId", "organizationId", "callId", provider, operation, model, unit,
         "reservedMicros", "accountedMicros", "pricingSource", "pricingVersion", "microsPerUnit")
      VALUES (${id}, ${scope.userId}, ${scope.spaceId},
        (SELECT "organizationId" FROM spaces WHERE id = ${scope.spaceId}), ${scope.callId ?? null}, ${provider},
        ${operation}, ${price.model}, ${price.unit}, ${BigInt(price.maxRequestMicros)},
        ${BigInt(price.maxRequestMicros)}, ${price.source}, ${price.version}, ${price.microsPerUnit})`;
    }),
  );
  return id;
}

/** Computed list-price costs are estimates, never a claim of an invoice-confirmed charge. */
export async function settleSpeech(
  prisma: Pick<PrismaClient, "$transaction">,
  id: string,
  usage: VoiceUsage | undefined,
  providerRequestId?: string,
) {
  const context = currentDbContext();
  if (!context) throw new Error("Speech settlement requires account context");
  await runAsSystem("Settle operator-funded speech within the authenticated scope", () =>
    prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<
        Array<{
          userId: string;
          spaceId: string;
          model: string;
          unit: string;
          calculatedMicros: string | null;
          reservedMicros: bigint;
        }>
      >`SELECT "userId", "spaceId", model, unit, "reservedMicros",
      ceil(${usage && Number.isFinite(usage.units) && usage.units >= 0 ? String(usage.units) : null}::numeric
        * ("microsPerUnit"::text)::numeric)::text AS "calculatedMicros" FROM speech_costs
      WHERE id = ${id} AND state = 'pending' FOR UPDATE`;
      if (!row) return;
      if (
        context.kind === "tenant" &&
        (row.userId !== context.userId || row.spaceId !== context.spaceId)
      )
        throw new ClientError("FORBIDDEN", "Speech settlement requires the owning account context");
      const matches =
        usage &&
        usage.model === row.model &&
        usage.unit === row.unit &&
        // Token totals do not encode the distinct prices of text/audio input and output.
        usage.unit !== "tokens" &&
        Number.isFinite(usage.units) &&
        usage.units >= 0;
      // Decimal multiplication avoids rounding an exact integer up due to binary floats.
      const calculated =
        matches && row.calculatedMicros !== null ? Number(row.calculatedMicros) : null;
      const micros = calculated !== null && Number.isSafeInteger(calculated) ? calculated : null;
      // Unknown costs keep the reservation. Observed overages also count against future admission.
      await tx.$executeRaw`UPDATE speech_costs SET
      state = ${micros !== null ? "estimated" : "unresolved"},
      units = ${usage?.units ?? null}, "observedModel" = ${usage?.model ?? null},
      "observedUnit" = ${usage?.unit ?? null}, "costMicros" = ${micros},
      "accountedMicros" = ${micros !== null ? BigInt(micros) : row.reservedMicros},
      "billableUnits" = ${usage ? JSON.stringify(usage) : null}::jsonb,
      "providerRequestId" = ${providerRequestId ?? null}, "updatedAt" = now()
      WHERE id = ${id}`;
    }),
  );
}

/** Operator reconciliation only. Zero is valid solely with evidence that no charge occurred. */
export async function confirmSpeechCost(
  prisma: Pick<PrismaClient, "$transaction">,
  id: string,
  evidence: { costMicros: bigint; source: string; reference: string },
) {
  const context = currentDbContext();
  if (!context) throw new Error("Speech reconciliation requires system context");
  if (context.kind !== "system")
    throw new ClientError("FORBIDDEN", "Speech reconciliation requires system context");
  if (evidence.costMicros < 0n || !evidence.source || !evidence.reference)
    throw new ClientError("BAD_REQUEST", "Invalid speech cost evidence");
  await prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<
      Array<{
        userId: string;
        accountedMicros: bigint;
        state: string;
        costMicros: bigint | null;
        confirmationReference: string | null;
        confirmationSource: string | null;
      }>
    >`
      SELECT "userId", "accountedMicros", state, "costMicros", "confirmationReference", "confirmationSource"
      FROM speech_costs WHERE id = ${id} FOR UPDATE`;
    if (!row) throw new ClientError("NOT_FOUND", "Speech cost not found");
    if (row.state === "confirmed") {
      if (
        row.costMicros !== evidence.costMicros ||
        row.confirmationReference !== evidence.reference ||
        row.confirmationSource !== evidence.source
      )
        throw new ClientError("CONFLICT", "Speech cost already confirmed with different evidence");
      return;
    }
    await tx.$executeRaw`UPDATE speech_costs SET state = 'confirmed',
      "costMicros" = ${evidence.costMicros}, "accountedMicros" = ${evidence.costMicros},
      "confirmationSource" = ${evidence.source}, "confirmationReference" = ${evidence.reference},
      "updatedAt" = now() WHERE id = ${id}`;
  });
}
