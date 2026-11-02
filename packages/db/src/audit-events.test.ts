import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installAuditEventStore, listAuditEvents, recordAuditEvent } from "./audit-events.js";
import { recordSecurityEvent, withSecurityRequest } from "./security-events.js";

function fakeStore() {
  const rows: Array<Record<string, unknown>> = [];
  return {
    rows,
    auditEvent: {
      createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
        rows.push(...data);
        return { count: data.length };
      }),
    },
    space: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === "space-1" ? { organizationId: "org-1", name: "Acme" } : null,
      ),
    },
    user: {
      findUnique: vi.fn(async () => ({ email: "owner@example.test" })),
    },
    member: {
      findMany: vi.fn(async () => [{ organizationId: "org-1" }, { organizationId: "org-2" }]),
    },
  };
}

let sink: ReturnType<typeof createTestSink>;
let store: ReturnType<typeof fakeStore>;

beforeEach(() => {
  sink = createTestSink();
  installLogger(createLogger({ service: "rakazo-api", sinks: [sink], level: "debug" }));
  store = fakeStore();
  installAuditEventStore(store as never);
});

afterEach(() => installAuditEventStore(undefined));

describe("recordAuditEvent", () => {
  it("copies labels so the row reads the same after its space and bot are gone", async () => {
    await recordAuditEvent({
      action: "tool.call",
      actor: { type: "bot", id: "bot-1", label: "Researcher" },
      spaceId: "space-1",
      target: { type: "tool", id: "gmail_send", label: "Gmail send" },
      runId: "run-1",
      threadId: "thread-1",
      metadata: { effectId: "effect-1" },
    });
    expect(store.rows).toEqual([
      expect.objectContaining({
        organizationId: "org-1",
        spaceId: "space-1",
        spaceName: "Acme",
        actorType: "bot",
        actorId: "bot-1",
        actorLabel: "Researcher",
        action: "tool.call",
        targetLabel: "Gmail send",
        outcome: "success",
        runId: "run-1",
        threadId: "thread-1",
        metadata: { effectId: "effect-1" },
      }),
    ]);
  });

  it("records a user's caller and gives an account-wide event to each of their organizations", async () => {
    await withSecurityRequest({ ip: "203.0.113.5", userAgent: "Mozilla/5.0" }, () =>
      recordAuditEvent({ action: "auth.sign_in", actor: { type: "user", id: "user-1" } }),
    );
    expect(store.rows.map((row) => row.organizationId)).toEqual(["org-1", "org-2"]);
    expect(store.rows[0]).toMatchObject({
      actorLabel: "owner@example.test",
      ip: "203.0.113.5",
      userAgent: "Mozilla/5.0",
    });
  });

  it("keeps secret values and message content out of the row", async () => {
    await recordAuditEvent({
      action: "credential.changed",
      actor: { type: "user", id: "user-1" },
      spaceId: "space-1",
      metadata: {
        kind: "vault_credential",
        name: "GITHUB_TOKEN",
        secret: "ghp-secret-value",
        apiKey: "sk-test-value",
        message: "send the quarterly numbers",
        note: "Bearer fake-bearer-value",
      },
    });
    const stored = JSON.stringify(store.rows);
    for (const sensitive of ["ghp-secret-value", "sk-test-value", "quarterly", "fake-bearer"]) {
      expect(stored).not.toContain(sensitive);
    }
    expect(store.rows[0]?.metadata).toMatchObject({
      kind: "vault_credential",
      name: "GITHUB_TOKEN",
    });
  });

  it("never throws, and logs the event it could not store", async () => {
    store.auditEvent.createMany.mockRejectedValueOnce(new Error("connection reset"));
    await expect(
      recordAuditEvent({
        action: "space.deleted",
        actor: { type: "user", id: "user-1" },
        organizationId: "org-1",
        target: { type: "space", id: "space-9", label: "Old" },
      }),
    ).resolves.toBeUndefined();
    expect(sink.events.find((event) => event.message === "audit.event.write_failed")).toMatchObject(
      {
        level: "error",
        "audit.event.action": "space.deleted",
        "audit.event.actor": "user:user-1",
        "audit.event.target": "space:space-9",
      },
    );
  });
});

describe("security events in the audit log", () => {
  it("records an account's own security action in its organization", async () => {
    await recordSecurityEvent({
      type: "credential.deleted",
      userId: "user-1",
      spaceId: "space-1",
      metadata: { kind: "model", provider: "openrouter" },
    });
    expect(store.rows).toEqual([
      expect.objectContaining({
        organizationId: "org-1",
        action: "credential.deleted",
        actorType: "user",
        actorId: "user-1",
        targetType: "model",
      }),
    ]);
  });

  it("leaves deployment-wide signals out", async () => {
    await recordSecurityEvent({ type: "auth.sign_in.failed", ip: "203.0.113.5" });
    await recordSecurityEvent({ type: "rate_limit.hit", userId: "user-1", ip: "203.0.113.5" });
    await recordSecurityEvent({ type: "deployment.settings.changed", userId: "user-1" });
    expect(store.rows).toEqual([]);
  });
});

describe("listAuditEvents", () => {
  it("scopes every query to the organization and pages past the cursor", async () => {
    const createdAt = new Date("2026-10-30T10:00:00.000Z");
    const row = (id: string) => ({
      id,
      createdAt,
      organizationId: "org-1",
      spaceId: null,
      spaceName: null,
      actorType: "user",
      actorId: "user-1",
      actorLabel: null,
      action: "space.created",
      targetType: null,
      targetId: null,
      targetLabel: null,
      outcome: "success",
      runId: null,
      threadId: null,
      ip: null,
      userAgent: null,
      metadata: {},
    });
    const db = {
      auditEvent: {
        findFirst: vi.fn(async () => ({ id: "event-9", createdAt })),
        findMany: vi.fn(async (_args: unknown) => [row("event-8"), row("event-7"), row("event-6")]),
      },
    };
    const page = await listAuditEvents(db as never, "org-1", {
      cursor: "event-9",
      limit: 2,
      action: "space.created",
    });
    expect(page.events.map((event) => event.id)).toEqual(["event-8", "event-7"]);
    expect(page.nextCursor).toBe("event-7");
    expect(db.auditEvent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "event-9", organizationId: "org-1" } }),
    );
    const where = (db.auditEvent.findMany.mock.calls[0]![0] as { where: Record<string, unknown> })
      .where;
    expect(where).toMatchObject({ organizationId: "org-1", action: "space.created" });
  });
});
