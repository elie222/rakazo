import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../database/client.js";
import { threadLiveActivities } from "./run-live-activity.js";

function prismaWith(payloads: Record<string, unknown>) {
  const $queryRaw = vi.fn(async (query: { values: unknown[] }) =>
    (query.values[0] as string[]).flatMap((runId) =>
      runId in payloads
        ? [
            {
              id: `event-${runId}`,
              runId,
              threadId: "ignored",
              spaceId: "space-1",
              payload: payloads[runId],
            },
          ]
        : [],
    ),
  );
  return { prisma: { $queryRaw } as unknown as Pick<PrismaClient, "$queryRaw">, $queryRaw };
}

const running = (id: string, threadId: string) => ({ id, status: "running", threadId });

async function activityOf(payload: unknown) {
  const { prisma } = prismaWith({ "run-1": payload });
  const activities = await threadLiveActivities(prisma, [
    { threadId: "thread-1", runs: [running("run-1", "thread-1")] },
  ]);
  return activities.get("thread-1");
}

describe("threadLiveActivities", () => {
  it("reads the step each running chat shows last, in one query", async () => {
    const { prisma, $queryRaw } = prismaWith({
      "run-1": { text: " Reading  q3-report.pdf\n", activity: true },
      "run-2": { delta: " sales rose", streaming: true },
    });
    const activities = await threadLiveActivities(prisma, [
      { threadId: "thread-1", runs: [running("run-1", "thread-1")] },
      { threadId: "thread-2", runs: [running("run-2", "thread-2")] },
    ]);
    expect(activities).toEqual(
      new Map([
        ["thread-1", { kind: "step", text: "Reading q3-report.pdf" }],
        ["thread-2", { kind: "writing" }],
      ]),
    );
    expect($queryRaw).toHaveBeenCalledTimes(1);
  });

  it("keeps a long step short", async () => {
    const activity = await activityOf({ text: `Running: ${"x".repeat(300)}`, activity: true });
    expect(activity?.kind === "step" && activity.text.length).toBeLessThanOrEqual(120);
  });

  it("counts only streamed reply text as writing", async () => {
    await expect(
      activityOf({ text: "Stopped: more than 80 tool calls in one turn." }),
    ).resolves.toBe(undefined);
    await expect(activityOf({ delta: " ", streaming: true })).resolves.toEqual({ kind: "writing" });
  });

  it("is empty while the bot thinks or has a stored payload it cannot read", async () => {
    await expect(activityOf({ text: "", activity: true })).resolves.toBeUndefined();
    await expect(activityOf(["not", "a", "payload"])).resolves.toBeUndefined();
  });

  it("reads the chat's own running work even when work in another chat is newer", async () => {
    const { prisma } = prismaWith({
      "group-run": { text: "Posting in the group", activity: true },
      "own-run": { text: "Reading the brief", activity: true },
    });
    const activities = await threadLiveActivities(prisma, [
      {
        threadId: "thread-1",
        runs: [running("group-run", "group-thread"), running("own-run", "thread-1")],
      },
    ]);
    expect(activities).toEqual(
      new Map([["thread-1", { kind: "step", text: "Reading the brief" }]]),
    );
  });

  it("queries nothing when no chat has running work", async () => {
    const { prisma, $queryRaw } = prismaWith({});
    const activities = await threadLiveActivities(prisma, [
      {
        threadId: "thread-1",
        runs: [{ id: "run-1", status: "waiting_input", threadId: "thread-1" }],
      },
      { threadId: "thread-2", runs: [running("run-2", "group-thread")] },
      { threadId: undefined, runs: [running("run-3", "thread-3")] },
    ]);
    expect(activities.size).toBe(0);
    expect($queryRaw).not.toHaveBeenCalled();
  });
});
