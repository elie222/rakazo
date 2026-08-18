import { describe, expect, it, vi } from "vitest";
import type { GtasksSlackPort } from "./gtasks-slack-composio-port.js";
import { ComposioEmulator } from "./composio-emulator.js";
import { GTASKS_SLACK_LANE, GTASKS_SLACK_ROUTING } from "./gtasks-slack-config.js";
import {
  connectionsReadyForGtasksSlack,
  formatGtaskSlackMirror,
  gtaskMirrorFingerprint,
  syncGtasksSlackInbox,
  type GtaskInboxItem,
} from "./gtasks-slack-mirror.js";

type MirrorStore = Map<string, { fingerprint: string; slackMessageTs: string }>;

function mirrorKey(workspaceId: string, externalId: string) {
  return `${workspaceId}:${GTASKS_SLACK_LANE}:${externalId}`;
}

function createMockPrisma(store: MirrorStore) {
  return {
    integrationMirror: {
      findUnique: vi.fn(async ({ where }: { where: { workspaceId_lane_externalId: {
        workspaceId: string;
        lane: string;
        externalId: string;
      } } }) => {
        const key = mirrorKey(
          where.workspaceId_lane_externalId.workspaceId,
          where.workspaceId_lane_externalId.externalId,
        );
        const row = store.get(key);
        if (!row) return null;
        return {
          id: key,
          workspaceId: where.workspaceId_lane_externalId.workspaceId,
          lane: GTASKS_SLACK_LANE,
          externalId: where.workspaceId_lane_externalId.externalId,
          fingerprint: row.fingerprint,
          slackMessageTs: row.slackMessageTs,
        };
      }),
      create: vi.fn(
        async ({
          data,
        }: {
          data: {
            workspaceId: string;
            lane: string;
            externalId: string;
            fingerprint: string;
            slackMessageTs: string;
          };
        }) => {
          const key = mirrorKey(data.workspaceId, data.externalId);
          if (store.has(key)) {
            const error = new Error("unique") as Error & { code?: string };
            error.code = "P2002";
            throw error;
          }
          store.set(key, { fingerprint: data.fingerprint, slackMessageTs: data.slackMessageTs });
          return { id: key, ...data };
        },
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: { fingerprint: string };
        }) => {
          const row = [...store.entries()].find(([id]) => id === where.id);
          if (!row) throw new Error("missing");
          store.set(row[0], { ...row[1], fingerprint: data.fingerprint });
          return { id: where.id, fingerprint: data.fingerprint };
        },
      ),
    },
    bot: {
      findFirst: vi.fn(async () => ({ id: "bot-1", threadId: "thread-1" })),
    },
  };
}

function createMockPort(tasks: GtaskInboxItem[]): GtasksSlackPort & {
  posts: Array<{ text: string; messageTs: string }>;
  updates: Array<{ messageTs: string; text: string }>;
} {
  const posts: Array<{ text: string; messageTs: string }> = [];
  const updates: Array<{ messageTs: string; text: string }> = [];
  let counter = 0;
  return {
    posts,
    updates,
    async listInboxTasks() {
      return tasks;
    },
    async postSlackMessage(_ctx, text) {
      counter += 1;
      const messageTs = `ts-${counter}`;
      posts.push({ text, messageTs });
      return { messageTs };
    },
    async updateSlackMessage(_ctx, messageTs, text) {
      updates.push({ messageTs, text });
    },
  };
}

const ctx = { workspaceId: "ws-1", userId: "user-1" };

describe("gtasks-slack mirror", () => {
  it("mirrors a new inbox item to the configured Slack channel", async () => {
    const store: MirrorStore = new Map();
    const port = createMockPort([{ id: "task-1", title: "Buy milk", due: "2026-08-20" }]);
    const composio = new ComposioEmulator();
    await composio.begin({ provider: "GOOGLETASKS", redirectUrl: "http://example.test" }, {
      ...ctx,
      operationId: "test",
      traceId: "test",
      signal: AbortSignal.timeout(1000),
    });
    await composio.begin({ provider: "SLACK", redirectUrl: "http://example.test" }, {
      ...ctx,
      operationId: "test",
      traceId: "test",
      signal: AbortSignal.timeout(1000),
    });

    const result = await syncGtasksSlackInbox(
      { prisma: createMockPrisma(store) as never, composio, port },
      ctx,
    );

    expect(result).toEqual({ status: "ok", created: 1, updated: 0, unchanged: 0 });
    expect(port.posts).toHaveLength(1);
    expect(port.posts[0]?.text).toContain("Buy milk");
    expect(port.posts[0]?.text).toContain("googletasks:task-1");
  });

  it("does not duplicate Slack posts on unchanged replay", async () => {
    const store: MirrorStore = new Map();
    const task: GtaskInboxItem = { id: "task-2", title: "Draft doc" };
    const port = createMockPort([task]);
    const composio = new ComposioEmulator();
    for (const provider of ["GOOGLETASKS", "SLACK"] as const) {
      await composio.begin({ provider, redirectUrl: "http://example.test" }, {
        ...ctx,
        operationId: "test",
        traceId: "test",
        signal: AbortSignal.timeout(1000),
      });
    }
    const deps = { prisma: createMockPrisma(store) as never, composio, port };

    await syncGtasksSlackInbox(deps, ctx);
    const second = await syncGtasksSlackInbox(deps, ctx);

    expect(second).toEqual({ status: "ok", created: 0, updated: 0, unchanged: 1 });
    expect(port.posts).toHaveLength(1);
    expect(port.updates).toHaveLength(0);
  });

  it("updates Slack when inbox content materially changes", async () => {
    const store: MirrorStore = new Map();
    let tasks: GtaskInboxItem[] = [{ id: "task-3", title: "Call Sam" }];
    const port = createMockPort(tasks);
    port.listInboxTasks = vi.fn(async () => tasks);
    const composio = new ComposioEmulator();
    for (const provider of ["GOOGLETASKS", "SLACK"] as const) {
      await composio.begin({ provider, redirectUrl: "http://example.test" }, {
        ...ctx,
        operationId: "test",
        traceId: "test",
        signal: AbortSignal.timeout(1000),
      });
    }
    const deps = { prisma: createMockPrisma(store) as never, composio, port };

    await syncGtasksSlackInbox(deps, ctx);
    tasks = [{ id: "task-3", title: "Call Sam tomorrow", notes: "after lunch" }];
    const result = await syncGtasksSlackInbox(deps, ctx);

    expect(result).toEqual({ status: "ok", created: 0, updated: 1, unchanged: 0 });
    expect(port.posts).toHaveLength(1);
    expect(port.updates).toHaveLength(1);
    expect(port.updates[0]?.text).toContain("after lunch");
    expect(gtaskMirrorFingerprint(tasks[0]!)).not.toBe(
      gtaskMirrorFingerprint({ id: "task-3", title: "Call Sam" }),
    );
  });

  it("handles retry and concurrent create races without duplicate posts", async () => {
    const store: MirrorStore = new Map();
    const port = createMockPort([{ id: "task-4", title: "Race task" }]);
    const prisma = createMockPrisma(store);
    const composio = new ComposioEmulator();
    for (const provider of ["GOOGLETASKS", "SLACK"] as const) {
      await composio.begin({ provider, redirectUrl: "http://example.test" }, {
        ...ctx,
        operationId: "test",
        traceId: "test",
        signal: AbortSignal.timeout(1000),
      });
    }
    const deps = { prisma: prisma as never, composio, port };

    store.set(mirrorKey(ctx.workspaceId, "task-4"), {
      fingerprint: gtaskMirrorFingerprint({ id: "task-4", title: "Race task" }),
      slackMessageTs: "ts-existing",
    });

    const result = await syncGtasksSlackInbox(deps, ctx);
    expect(result).toEqual({ status: "ok", created: 0, updated: 0, unchanged: 1 });
    expect(port.posts).toHaveLength(0);
  });

  it("skips when either connector is unavailable", async () => {
    const store: MirrorStore = new Map();
    const port = createMockPort([{ id: "task-5", title: "No connectors" }]);
    const composio = new ComposioEmulator();

    const result = await syncGtasksSlackInbox(
      { prisma: createMockPrisma(store) as never, composio, port },
      ctx,
    );

    expect(result).toEqual({ status: "skipped", reason: "connector_unavailable" });
    expect(port.posts).toHaveLength(0);
    expect(await connectionsReadyForGtasksSlack(composio, ctx.userId)).toEqual({
      googleTasks: false,
      slack: false,
    });
  });

  it("returns sanitized errors without leaking secrets", async () => {
    const store: MirrorStore = new Map();
    const port: GtasksSlackPort = {
      listInboxTasks: vi.fn(async () => {
        throw new Error("denied COMPOSIO_API_KEY=ak_supersecret");
      }),
      postSlackMessage: vi.fn(),
      updateSlackMessage: vi.fn(),
    };
    const composio = new ComposioEmulator();
    for (const provider of ["GOOGLETASKS", "SLACK"] as const) {
      await composio.begin({ provider, redirectUrl: "http://example.test" }, {
        ...ctx,
        operationId: "test",
        traceId: "test",
        signal: AbortSignal.timeout(1000),
      });
    }

    const result = await syncGtasksSlackInbox(
      { prisma: createMockPrisma(store) as never, composio, port },
      ctx,
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).not.toContain("ak_supersecret");
      expect(result.message).toContain("[redacted]");
    }
  });
});
