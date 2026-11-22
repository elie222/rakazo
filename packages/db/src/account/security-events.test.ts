import { createLogger, createTestSink, installLogger, runWithLogContext } from "@rakazo/logging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSecurityEventPruner,
  installSecurityEventStore,
  pruneSecurityEvents,
  recordSecurityEvent,
  securityEventRetentionDays,
  withSecurityRequest,
} from "./security-events.js";

function fakeStore() {
  const rows: Array<Record<string, unknown>> = [];
  return {
    rows,
    securityEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        rows.push(data);
        return data;
      }),
      deleteMany: vi.fn(async (_args: unknown) => ({ count: 2 })),
    },
  };
}

let sink: ReturnType<typeof createTestSink>;
let store: ReturnType<typeof fakeStore>;

beforeEach(() => {
  sink = createTestSink();
  installLogger(createLogger({ service: "rakazo-api", sinks: [sink], level: "debug" }));
  store = fakeStore();
  installSecurityEventStore(store as never);
});

afterEach(() => installSecurityEventStore(undefined));

describe("recordSecurityEvent", () => {
  it("stores the request's caller and identifiers, and nothing a user said or a secret", async () => {
    await runWithLogContext(
      {
        "user.id": "user-1",
        "space.id": "space-1",
      },
      () =>
        withSecurityRequest({ ip: "203.0.113.5", userAgent: "Mozilla/5.0" }, () =>
          recordSecurityEvent({
            type: "credential.created",
            metadata: {
              kind: "model",
              provider: "openrouter",
              apiKey: "sk-test-xxxxxxxxxxxxxxxxxxxxxxxx",
              token: "session-token",
              message: "please summarise my inbox",
              content: "private text",
              label: "owner@example.org",
              note: "Bearer fake-value",
              nested: { deep: "value" } as never,
              long: "x".repeat(500),
            },
          }),
        ),
    );

    expect(store.rows).toHaveLength(1);
    const row = store.rows[0]!;
    expect(row).toMatchObject({
      type: "credential.created",
      userId: "user-1",
      spaceId: "space-1",
      ip: "203.0.113.5",
      userAgent: "Mozilla/5.0",
    });
    const metadata = row.metadata as Record<string, unknown>;
    expect(metadata).toMatchObject({ kind: "model", provider: "openrouter" });
    for (const dropped of ["apiKey", "token", "message", "content", "nested"]) {
      expect(metadata, dropped).not.toHaveProperty(dropped);
    }
    expect((metadata.long as string).length).toBe(200);
    const stored = JSON.stringify(row);
    for (const sensitive of [
      "sk-test-",
      "session-token",
      "summarise",
      "private text",
      "owner@example.org",
      "fake-value",
    ]) {
      expect(stored).not.toContain(sensitive);
    }
  });

  it("emits one structured log line for the log sink", async () => {
    await recordSecurityEvent({
      type: "egress.refused",
      userId: "user-2",
      ip: "198.51.100.7",
      metadata: { host: "169.254.169.254", reason: "Connector URL targets a private host" },
    });
    const line = sink.events.find((event) => event.message === "security.event");
    expect(line).toMatchObject({
      level: "warn",
      "security.event.type": "egress.refused",
      "user.id": "user-2",
      "client.ip": "198.51.100.7",
      "security.event.metadata": { host: "169.254.169.254" },
    });
  });

  it("isolates concurrent callers and restores the enclosing caller", async () => {
    await withSecurityRequest({ ip: "192.0.2.1", userAgent: "example-agent" }, async () => {
      await Promise.all(
        ["192.0.2.2", "192.0.2.3"].map((ip) =>
          withSecurityRequest({ ip }, async () => {
            await Promise.resolve();
            await recordSecurityEvent({ type: "auth.sign_out" });
          }),
        ),
      );
      await recordSecurityEvent({ type: "auth.sign_out", ip: "192.0.2.4" });
      await recordSecurityEvent({ type: "auth.sign_out" });
    });
    await recordSecurityEvent({ type: "auth.sign_out" });
    expect(store.rows.map((row) => [row.ip, row.userAgent])).toEqual([
      ["192.0.2.2", null],
      ["192.0.2.3", null],
      ["192.0.2.4", "example-agent"],
      ["192.0.2.1", "example-agent"],
      [null, null],
    ]);
  });

  it("still logs and never throws when the database write fails", async () => {
    store.securityEvent.create.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(recordSecurityEvent({ type: "auth.sign_out" })).resolves.toBeUndefined();
    expect(sink.events.map((event) => event.message)).toEqual([
      "security.event",
      "security.event.write_failed",
    ]);
  });

  it("only logs before a store is installed", async () => {
    installSecurityEventStore(undefined);
    await recordSecurityEvent({ type: "auth.sign_up", userId: "user-3" });
    expect(store.securityEvent.create).not.toHaveBeenCalled();
    expect(sink.events).toHaveLength(1);
  });
});

describe("retention", () => {
  it("defaults to 90 days and accepts a positive override", () => {
    expect(securityEventRetentionDays({})).toBe(90);
    expect(securityEventRetentionDays({ SECURITY_EVENT_RETENTION_DAYS: "30" })).toBe(30);
    expect(securityEventRetentionDays({ SECURITY_EVENT_RETENTION_DAYS: "  " })).toBe(90);
  });

  it.each(["0", "-1", "soon", "1.5", "2y", "30 days", "36501", "99999999999999"])(
    "refuses %j instead of falling back or never pruning",
    (value) => {
      expect(() => securityEventRetentionDays({ SECURITY_EVENT_RETENTION_DAYS: value })).toThrow(
        /SECURITY_EVENT_RETENTION_DAYS must be a whole number of days from 1 to 36500/,
      );
    },
  );

  it("deletes only events older than the window", async () => {
    const removed = await pruneSecurityEvents(
      store as never,
      30,
      new Date("2026-10-21T00:00:00.000Z"),
    );
    expect(removed).toBe(2);
    expect(store.securityEvent.deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: new Date("2026-09-21T00:00:00.000Z") } },
    });
  });

  it("prunes at most once an hour from a frequent reconciler tick", async () => {
    let now = new Date("2026-10-21T00:00:00.000Z").getTime();
    const prune = createSecurityEventPruner(store as never, 90, { now: () => new Date(now) });
    await prune();
    now += 30 * 60 * 1000;
    await prune();
    expect(store.securityEvent.deleteMany).toHaveBeenCalledTimes(1);
    now += 31 * 60 * 1000;
    await prune();
    expect(store.securityEvent.deleteMany).toHaveBeenCalledTimes(2);
  });
});
