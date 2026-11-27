import { createHmac } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  assertCallbackUrl,
  deliverTaskCallback,
  signTaskCallback,
  TASK_CALLBACK_RECHECK_MS,
  taskCallbackSecret,
} from "./task-callbacks.js";

const now = new Date("2026-11-25T12:00:00Z");
const publicResolver = async () => [{ address: "203.0.113.10", family: 4 as const }];
const url = "https://hooks.example.test/rakazo";

function setup(
  runStatus: string,
  {
    answer = 204,
    delivered = {} as { runId?: string; status?: string },
    keyActive = true,
    member = true,
  } = {},
) {
  const update = vi.fn(async () => ({ count: 1 }));
  const prisma = {
    taskCallback: {
      findUnique: vi.fn(async () => ({
        id: "callback-1",
        taskId: "task-1",
        url,
        userId: "user-1",
        spaceId: "space-1",
        issuerKeyId: "key-1",
        deliveredRunId: delivered.runId ?? null,
        deliveredStatus: delivered.status ?? null,
        deliveredAt: null,
        createdAt: now,
      })),
      updateMany: update,
    },
    task: {
      findFirst: vi.fn(async () => ({
        id: "task-1",
        botId: "bot-1",
        createdAt: now,
        updatedAt: now,
        runs: [{ id: "run-1", status: runStatus, updatedAt: now }],
      })),
    },
    run: { findFirst: vi.fn(async () => ({ id: "run-1", createdAt: now })) },
    apiKey: { findFirst: vi.fn(async () => (keyActive ? { id: "key-1" } : null)) },
    spaceMember: { findFirst: vi.fn(async () => (member ? { userId: "user-1" } : null)) },
    message: {
      findMany: vi.fn(async () => [{ id: "m1", blocks: [{ kind: "text", text: "Done" }] }]),
    },
  } as unknown as PrismaClient;
  const enqueue = vi.fn(async () => undefined);
  const requests: Request[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return new Response(null, { status: answer });
  });
  const deliver = () =>
    deliverTaskCallback(
      {
        prisma,
        jobs: { enqueue },
        rootKey: "root-key",
        egress: { fetch: fetch as typeof globalThis.fetch, resolveHostname: publicResolver },
        now: () => now,
      },
      "task-1",
    );
  return { deliver, enqueue, requests, update };
}

describe("task callbacks", () => {
  it("checks back later while the task works, sending nothing", async () => {
    const { deliver, enqueue, requests } = setup("running");
    await deliver();
    expect(requests).toEqual([]);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "task.callback",
        payload: { taskId: "task-1" },
        availableAt: new Date(now.getTime() + TASK_CALLBACK_RECHECK_MS),
      }),
    );
  });

  it("posts a settled task signed with the person's secret for that address", async () => {
    const { deliver, requests, update } = setup("completed");
    await deliver();
    const [request] = requests;
    const body = await request!.text();
    expect(JSON.parse(body)).toMatchObject({
      type: "task.settled",
      id: "task-1:run-1:completed",
      task: { id: "task-1", status: "completed", output: "Done" },
      truncated: false,
    });
    expect(request!.headers.get("x-rakazo-delivery")).toBe("task-1:run-1:completed");
    const secret = taskCallbackSecret("root-key", "key-1", url);
    const timestamp = Math.floor(now.getTime() / 1000);
    const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
    expect(request!.headers.get("x-rakazo-signature")).toBe(`t=${timestamp},v1=${expected}`);
    expect(update).toHaveBeenCalledWith({
      where: { id: "callback-1", url, issuerKeyId: "key-1" },
      data: { deliveredAt: now, deliveredRunId: "run-1", deliveredStatus: "completed" },
    });
  });

  it("sends each settled state once, and a later one again", async () => {
    const same = setup("completed", { delivered: { runId: "run-1", status: "completed" } });
    await same.deliver();
    expect(same.requests).toEqual([]);
    const answered = setup("completed", { delivered: { runId: "run-1", status: "needs_input" } });
    await answered.deliver();
    expect(answered.requests).toHaveLength(1);
  });

  it("sends each question a waiting run asks, and keeps watching it", async () => {
    const { deliver, enqueue, requests } = setup("waiting_input", {
      delivered: { runId: "run-1", status: "needs_input:0000000000000000" },
    });
    await deliver();
    expect(JSON.parse(await requests[0]!.text())).toMatchObject({
      id: expect.stringMatching(/^task-1:run-1:needs_input:[0-9a-f]{16}$/),
    });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "task.callback" }));
  });

  it("stops for good once the key is revoked or the person left the Space", async () => {
    for (const lost of [{ keyActive: false }, { member: false }]) {
      const { deliver, enqueue, requests } = setup("completed", lost);
      await deliver();
      expect(requests).toEqual([]);
      expect(enqueue).not.toHaveBeenCalled();
    }
  });

  it("leaves a refused delivery for the queue to retry", async () => {
    const { deliver, update } = setup("failed", { answer: 500 });
    await expect(deliver()).rejects.toThrow("Task callback answered 500");
    expect(update).not.toHaveBeenCalled();
  });

  it("refuses up front an address a callback could never reach", async () => {
    await expect(assertCallbackUrl(url, publicResolver)).resolves.toBeUndefined();
    for (const refused of [
      "https://hooks.example.test:8443/rakazo",
      "https://127.0.0.1/rakazo",
      "https://localhost/rakazo",
    ])
      await expect(assertCallbackUrl(refused, publicResolver)).rejects.toMatchObject({
        kind: "BAD_REQUEST",
      });
  });

  it("signs with a stable, verifiable format", () => {
    expect(signTaskCallback("secret", "{}", 10)).toBe(
      `t=10,v1=${createHmac("sha256", "secret").update("10.{}").digest("hex")}`,
    );
  });
});
