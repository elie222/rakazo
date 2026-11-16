import type { Actor } from "@rakazo/contracts";
import { AuditEventFilterSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { auditLogAccess, auditLogScope, exportAuditEvents, recordAuditEvent } from "@rakazo/db";
import type { Hono } from "hono";

/**
 * `GET /api/audit-events/export`: the organization's audit log as JSON Lines, newest first. A
 * member who is not an owner or admin gets only their own events.
 */
export function mountAuditExportRoute(
  app: Hono,
  deps: { prisma: PrismaClient; sessionActor: (request: Request) => Promise<Actor | null> },
): void {
  app.get("/api/audit-events/export", async (c) => {
    const headers = { "cache-control": "no-store" };
    const actor = await deps.sessionActor(c.req.raw);
    if (!actor) return c.text("Unauthorized", 401, headers);
    const access = await auditLogAccess(deps.prisma, actor);
    if (!access) return c.text("Forbidden", 403, headers);
    const parsed = AuditEventFilterSchema.safeParse(c.req.query());
    if (!parsed.success) return c.text("Invalid filter", 400, headers);
    const filter = auditLogScope(access, parsed.data);
    await recordAuditEvent({
      action: "audit_log.exported",
      actor: { type: "user", id: actor.userId },
      organizationId: access.organizationId,
      metadata: filter,
    });
    const lines = exportAuditEvents(deps.prisma, access.organizationId, filter);
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await lines.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      },
      async cancel() {
        await lines.return(undefined);
      },
    });
    return new Response(body, {
      headers: {
        ...headers,
        "content-type": "application/x-ndjson",
        "content-disposition": `attachment; filename="rakazo-audit-log-${new Date().toISOString().slice(0, 10)}.jsonl"`,
      },
    });
  });
}
