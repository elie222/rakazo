import type { SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import * as z from "zod";

const key = z.string().min(1).max(512);
const scopeSchema = z.object({
  computer: z.object({ id: key, providerRef: key, botId: key, kind: z.literal("docker") }),
  botId: key,
  request: z.union([
    z
      .object({
        expectedInstallationId: z.string().regex(/^[a-f0-9]{32}$/),
        sessionScope: z.object({
          threadId: key,
          profileId: key,
          profileRevision: z.number().int().positive(),
          accountId: key,
          epoch: key,
        }),
      })
      .strict(),
    z
      .object({
        expectedInstallationId: z.string().regex(/^[a-f0-9]{32}$/),
        credentialScope: z.object({
          harness: z.enum(["codex", "kimi"]),
          connectionId: z.string().uuid(),
          epoch: z.string().uuid(),
        }),
      })
      .strict(),
  ]),
});

/** Run under the existing reconciliation leader. Exact obsolete epochs only; retry active leases. */
export async function reconcileNativeStateCleanup(deps: {
  prisma: PrismaClient;
  sandbox: SandboxProvider;
}): Promise<void> {
  if (!deps.sandbox.cleanupNativeState) return;
  const pending = await deps.prisma.nativeStateCleanup.findMany({
    orderBy: [{ attempts: "asc" }, { createdAt: "asc" }],
    take: 5,
  });
  for (const row of pending) {
    try {
      const scope = scopeSchema.parse(row.scope);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      timer.unref?.();
      try {
        await deps.sandbox.cleanupNativeState(scope.computer, scope.request, {
          operationId: row.id,
          traceId: row.id,
          runId: `native-cleanup-${row.id}`,
          botId: scope.botId,
          userId: row.userId,
          spaceId: row.spaceId,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      await deps.prisma.nativeStateCleanup.deleteMany({ where: { id: row.id } });
    } catch {
      // No raw vendor/container diagnostics in the durable queue or user-visible logs.
      await deps.prisma.nativeStateCleanup.updateMany({
        where: { id: row.id },
        data: {
          attempts: { increment: 1 },
          lastError:
            "Native state cleanup is pending; the computer may be unavailable or the namespace still leased.",
        },
      });
    }
  }
}
