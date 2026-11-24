import { createHmac } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  deliverTaskCallback,
  signTaskCallback,
  TASK_CALLBACK_RECHECK_MS,
  taskCallbackSecret,
} from "./task-callbacks.js";

const now = new Date("2026-11-25T12:00:00Z");
const publicResolver = async () => [{ address: "203.0.113.10", family: 4 as const }];

function setup(runStatus: string, answer = 204) {
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const prisma = {
    taskCallback: {
      findUnique: vi.fn(async () => ({
        id: "callback-1",
        taskId: "task-1",
        url: "https://hooks.example.test/rakazo",
        userId: "user-1",
        spaceId: "space-1",
        deliveredAt: null,
        createdAt: now,
      })),
      updateMany,
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
  return { deliver, enqueue, requests, updateMany };
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

  it("posts a settled task once, signed with the task's own secret", async () => {
    const { deliver, requests, updateMany } = setup("completed");
    await deliver();
    const [request] = requests;
    const body = await request!.text();
    expect(JSON.parse(body)).toMatchObject({
      type: "task.settled",
      task: { id: "task-1", status: "completed", output: "Done" },
    });
    const secret = taskCallbackSecret("root-key", "callback-1");
    const timestamp = Math.floor(now.getTime() / 1000);
    const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
    expect(request!.headers.get("x-rakazo-signature")).toBe(`t=${timestamp},v1=${expected}`);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "callback-1", deliveredAt: null },
      data: { deliveredAt: now },
    });
  });

  it("leaves a refused delivery for the queue to retry", async () => {
    const { deliver, updateMany } = setup("failed", 500);
    await expect(deliver()).rejects.toThrow("Task callback answered 500");
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("signs with a stable, verifiable format", () => {
    expect(signTaskCallback("secret", "{}", 10)).toBe(
      `t=10,v1=${createHmac("sha256", "secret").update("10.{}").digest("hex")}`,
    );
  });
});
