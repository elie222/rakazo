import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { activeTailnetRun, tailnetTunnelEvent } from "./tailnet-tunnel.js";

const CLAIMS = {
  runId: "run1",
  userId: "alice",
  spaceId: "home",
  botId: "helper",
  expiresAt: Date.now() + 60_000,
};

describe("tailnet tunnel runs", () => {
  it("finds the run only while it is active and matches every claim", async () => {
    const findFirst = vi.fn(async () => ({ threadId: "thread1", bot: { name: "Helper" } }));
    const prisma = { run: { findFirst } } as unknown as Pick<PrismaClient, "run">;
    expect(await activeTailnetRun(prisma, CLAIMS)).toEqual({
      userId: "alice",
      spaceId: "home",
      botId: "helper",
      botName: "Helper",
      threadId: "thread1",
    });
    const [query] = findFirst.mock.calls[0] as unknown as [
      { where: Record<string, unknown> & { status: { in: string[] } } },
    ];
    expect(query.where).toMatchObject({
      id: "run1",
      userId: "alice",
      spaceId: "home",
      botId: "helper",
    });
    expect(query.where.status.in).toContain("running");
    expect(query.where.status.in).not.toContain("completed");
    findFirst.mockResolvedValueOnce(null as never);
    expect(await activeTailnetRun(prisma, CLAIMS)).toBeUndefined();
  });
});

describe("tailnet tunnel activity", () => {
  const run = { ...CLAIMS, botName: "Helper", threadId: "thread1" };
  const destination = { host: "nas.tail1234.ts.net", port: 22 };

  it("records a finished connection in the run's thread", () => {
    expect(
      tailnetTunnelEvent({
        run,
        destination,
        outcome: "closed",
        bytesSent: 10,
        bytesReceived: 32,
        durationMs: 5,
      }),
    ).toMatchObject({
      spaceId: "home",
      threadId: "thread1",
      botId: "helper",
      runId: "run1",
      type: "computer.command",
      payload: {
        kind: "tailnet",
        command: "nas.tail1234.ts.net:22",
        status: "done",
        exitCode: 0,
        output: "",
        bytes: 42,
      },
    });
  });

  it("records why a connection was refused", () => {
    expect(
      tailnetTunnelEvent({
        run,
        destination,
        outcome: "refused",
        reason: "Ask to connect to nas.tail1234.ts.net:22 first.",
        bytesSent: 0,
        bytesReceived: 0,
        durationMs: 1,
      }).payload,
    ).toMatchObject({ exitCode: 1, output: "Ask to connect to nas.tail1234.ts.net:22 first." });
  });
});
