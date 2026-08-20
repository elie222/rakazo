import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import { ComposioEmulator } from "./composio-emulator.js";
import type { GtasksSlackPort } from "./gtasks-slack-composio-port.js";
import { GTASKS_SLACK_LANE, GTASKS_SLACK_ROUTING } from "./gtasks-slack-config.js";
import {
  connectionsReadyForGtasksSlack,
  formatGtaskSlackMirror,
  type GtaskInboxItem,
  gtaskMirrorFingerprint,
  gtaskSlackClientMessageId,
  syncGtasksSlackInbox,
} from "./gtasks-slack-mirror.js";

type MirrorStore = Map<
  string,
  {
    workspaceId: string;
    userId: string;
    fingerprint: string;
    sourceUpdatedAt: Date | null;
    slackMessageTs: string;
  }
>;

type MockBot = {
  id: string;
  workspaceId: string;
  userId: string;
  threadId: string;
  updatedAt: Date;
};

type MockPrismaOptions = {
  member?: boolean | (() => boolean);
  connectedProviders?: string[] | (() => string[]);
  onQuery?: (query: string) => void;
};

function mirrorKey(userId: string, externalId: string) {
  return `${userId}:${GTASKS_SLACK_LANE}:${externalId}`;
}

function createMockPrisma(
  store: MirrorStore,
  bots: MockBot[] = [],
  options: MockPrismaOptions = {},
) {
  const integrationMirror = {
    findUnique: vi.fn(
      async ({
        where,
      }: {
        where: {
          userId_lane_externalId: {
            userId: string;
            lane: string;
            externalId: string;
          };
        };
      }) => {
        const key = mirrorKey(
          where.userId_lane_externalId.userId,
          where.userId_lane_externalId.externalId,
        );
        const row = store.get(key);
        if (!row) return null;
        return {
          id: key,
          workspaceId: row.workspaceId,
          userId: row.userId,
          lane: GTASKS_SLACK_LANE,
          externalId: where.userId_lane_externalId.externalId,
          fingerprint: row.fingerprint,
          sourceUpdatedAt: row.sourceUpdatedAt,
          slackMessageTs: row.slackMessageTs,
        };
      },
    ),
    create: vi.fn(
      async ({
        data,
      }: {
        data: {
          workspaceId: string;
          userId: string;
          lane: string;
          externalId: string;
          fingerprint: string;
          sourceUpdatedAt: Date | null;
          slackMessageTs: string;
        };
      }) => {
        const key = mirrorKey(data.userId, data.externalId);
        if (store.has(key)) {
          const error = new Error("unique") as Error & { code?: string };
          error.code = "P2002";
          throw error;
        }
        store.set(key, {
          workspaceId: data.workspaceId,
          userId: data.userId,
          fingerprint: data.fingerprint,
          sourceUpdatedAt: data.sourceUpdatedAt,
          slackMessageTs: data.slackMessageTs,
        });
        return { id: key, ...data };
      },
    ),
    update: vi.fn(
      async ({
        where,
        data,
      }: {
        where: { id: string };
        data: {
          workspaceId?: string;
          fingerprint?: string;
          sourceUpdatedAt?: Date | null;
        };
      }) => {
        const row = [...store.entries()].find(([id]) => id === where.id);
        if (!row) throw new Error("missing");
        const updated = { ...row[1], ...data };
        store.set(row[0], updated);
        return { id: where.id, ...updated };
      },
    ),
  };
  const member = {
    findFirst: vi.fn(async () => {
      const active = typeof options.member === "function" ? options.member() : options.member;
      return active === false ? null : { id: "member-1" };
    }),
  };
  const connection = {
    findMany: vi.fn(async () => {
      const configured =
        typeof options.connectedProviders === "function"
          ? options.connectedProviders()
          : options.connectedProviders;
      return (
        configured ?? [
          GTASKS_SLACK_ROUTING.composioProviders.googleTasks,
          GTASKS_SLACK_ROUTING.composioProviders.slack,
        ]
      ).map((provider) => ({ provider }));
    }),
  };
  let transactionTail = Promise.resolve();
  const transactionClient = {
    integrationMirror,
    member,
    connection,
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      options.onQuery?.(query);
      if (query.includes('FROM "member"')) {
        const active = typeof options.member === "function" ? options.member() : options.member;
        return active === false ? [] : [{ id: "member-1" }];
      }
      if (query.includes('FROM "connections"')) {
        return connection.findMany();
      }
      return [];
    }),
  };

  return {
    integrationMirror,
    member,
    connection,
    $transaction: vi.fn(async (callback: (tx: typeof transactionClient) => Promise<unknown>) => {
      const previous = transactionTail;
      let release = () => {};
      transactionTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await callback(transactionClient);
      } finally {
        release();
      }
    }),
    bot: {
      findFirst: vi.fn(async ({ where }: { where: { workspaceId: string; userId?: string } }) => {
        const bot = bots
          .filter(
            (candidate) =>
              candidate.workspaceId === where.workspaceId &&
              (where.userId === undefined || candidate.userId === where.userId),
          )
          .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())[0];
        return bot ? { id: bot.id, thread: { id: bot.threadId } } : null;
      }),
    },
  };
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type MockInboxItem = Omit<GtaskInboxItem, "updated"> & { updated?: string };

function createMockPort(tasks: MockInboxItem[]): GtasksSlackPort & {
  posts: Array<{ text: string; messageTs: string; clientMessageId: string }>;
  updates: Array<{ messageTs: string; text: string }>;
} {
  const posts: Array<{ text: string; messageTs: string; clientMessageId: string }> = [];
  const updates: Array<{ messageTs: string; text: string }> = [];
  const delivered = new Map<string, string>();
  let counter = 0;
  return {
    posts,
    updates,
    async listInboxTasks() {
      return tasks.map((task) => ({ updated: "2026-08-18T10:00:00Z", ...task }));
    },
    async postSlackMessage(_ctx, text, clientMessageId) {
      const existing = delivered.get(clientMessageId);
      if (existing) return { messageTs: existing };
      counter += 1;
      const messageTs = `ts-${counter}`;
      delivered.set(clientMessageId, messageTs);
      posts.push({ text, messageTs, clientMessageId });
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
    await composio.begin(
      { provider: "GOOGLETASKS", redirectUrl: "http://example.test" },
      {
        ...ctx,
        operationId: "test",
        traceId: "test",
        signal: AbortSignal.timeout(1000),
      },
    );
    await composio.begin(
      { provider: "SLACK", redirectUrl: "http://example.test" },
      {
        ...ctx,
        operationId: "test",
        traceId: "test",
        signal: AbortSignal.timeout(1000),
      },
    );

    const result = await syncGtasksSlackInbox(
      { prisma: createMockPrisma(store) as never, composio, port },
      ctx,
    );

    expect(result).toEqual({ status: "ok", created: 1, updated: 0, unchanged: 0 });
    expect(port.posts).toHaveLength(1);
    expect(port.posts[0]?.text).toContain("Buy milk");
    expect(port.posts[0]?.text).toContain("googletasks:task-1");
    expect(port.posts[0]?.clientMessageId).toBe(gtaskSlackClientMessageId(ctx.userId, "task-1"));
  });

  it("renders untrusted task text without activating Slack control sequences", () => {
    const text = formatGtaskSlackMirror({
      id: "task-unsafe>",
      title: "Notify <!channel> & review",
      notes: "Open <https://malicious.example|this link>",
    });

    expect(text).toContain("Notify &lt;!channel&gt; &amp; review");
    expect(text).toContain("&lt;https://malicious.example|this link&gt;");
    expect(text).not.toContain("<!channel>");
    expect(text).not.toContain("<https://");
  });

  it("emits mirror provenance only to the connection owner's bot", async () => {
    const store: MirrorStore = new Map();
    const prisma = createMockPrisma(store, [
      {
        id: "bot-owner",
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        threadId: "thread-owner",
        updatedAt: new Date("2026-08-17T00:00:00Z"),
      },
      {
        id: "bot-other",
        workspaceId: ctx.workspaceId,
        userId: "user-2",
        threadId: "thread-other",
        updatedAt: new Date("2026-08-18T00:00:00Z"),
      },
    ]);
    const port = createMockPort([{ id: "task-owned", title: "Private task" }]);
    const composio = new ComposioEmulator();
    for (const provider of ["GOOGLETASKS", "SLACK"] as const) {
      await composio.begin(
        { provider, redirectUrl: "http://example.test" },
        {
          ...ctx,
          operationId: "test",
          traceId: "test",
          signal: AbortSignal.timeout(1000),
        },
      );
    }
    const append = vi.fn(async () => ({}));

    await syncGtasksSlackInbox(
      { prisma: prisma as never, composio, port, events: { append } as never },
      ctx,
    );

    expect(append).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: ctx.workspaceId,
        botId: "bot-owner",
        threadId: "thread-owner",
        payload: expect.objectContaining({ externalId: "task-owned" }),
      }),
    );
  });

  it("does not duplicate Slack posts on unchanged replay", async () => {
    const store: MirrorStore = new Map();
    const task: GtaskInboxItem = {
      id: "task-2",
      title: "Draft doc",
      updated: "2026-08-18T10:00:00Z",
    };
    const port = createMockPort([task]);
    const composio = new ComposioEmulator();
    for (const provider of ["GOOGLETASKS", "SLACK"] as const) {
      await composio.begin(
        { provider, redirectUrl: "http://example.test" },
        {
          ...ctx,
          operationId: "test",
          traceId: "test",
          signal: AbortSignal.timeout(1000),
        },
      );
    }
    const deps = { prisma: createMockPrisma(store) as never, composio, port };

    await syncGtasksSlackInbox(deps, ctx);
    const second = await syncGtasksSlackInbox(deps, ctx);

    expect(second).toEqual({ status: "ok", created: 0, updated: 0, unchanged: 1 });
    expect(port.posts).toHaveLength(1);
    expect(port.updates).toHaveLength(0);
  });

  it("keeps task delivery identity stable when the selected workspace changes", async () => {
    const store: MirrorStore = new Map();
    const task: GtaskInboxItem = {
      id: "task-workspace-change",
      title: "Keep one delivery",
      updated: "2026-08-18T10:00:00Z",
    };
    const port = createMockPort([task]);
    const composio = new ComposioEmulator();
    for (const provider of ["GOOGLETASKS", "SLACK"] as const) {
      await composio.begin(
        { provider, redirectUrl: "http://example.test" },
        {
          ...ctx,
          operationId: "test",
          traceId: "test",
          signal: AbortSignal.timeout(1000),
        },
      );
    }
    const deps = { prisma: createMockPrisma(store) as never, composio, port };

    await syncGtasksSlackInbox(deps, ctx);
    const changedWorkspace = await syncGtasksSlackInbox(deps, {
      workspaceId: "ws-2",
      userId: ctx.userId,
    });

    expect(changedWorkspace).toEqual({
      status: "ok",
      created: 0,
      updated: 0,
      unchanged: 1,
    });
    expect(port.posts).toHaveLength(1);
    expect(port.updates).toHaveLength(0);
    expect(store.get(mirrorKey(ctx.userId, task.id))).toMatchObject({
      workspaceId: "ws-2",
      userId: ctx.userId,
    });
  });

  it("updates Slack when inbox content materially changes", async () => {
    const store: MirrorStore = new Map();
    let tasks: GtaskInboxItem[] = [
      { id: "task-3", title: "Call Sam", updated: "2026-08-18T10:00:00Z" },
    ];
    const port = createMockPort(tasks);
    port.listInboxTasks = vi.fn(async () => tasks);
    const composio = new ComposioEmulator();
    for (const provider of ["GOOGLETASKS", "SLACK"] as const) {
      await composio.begin(
        { provider, redirectUrl: "http://example.test" },
        {
          ...ctx,
          operationId: "test",
          traceId: "test",
          signal: AbortSignal.timeout(1000),
        },
      );
    }
    const deps = { prisma: createMockPrisma(store) as never, composio, port };

    await syncGtasksSlackInbox(deps, ctx);
    tasks = [
      {
        id: "task-3",
        title: "Call Sam tomorrow",
        notes: "after lunch",
        updated: "2026-08-18T11:00:00Z",
      },
    ];
    const result = await syncGtasksSlackInbox(deps, ctx);

    expect(result).toEqual({ status: "ok", created: 0, updated: 1, unchanged: 0 });
    expect(port.posts).toHaveLength(1);
    expect(port.updates).toHaveLength(1);
    expect(port.updates[0]?.text).toContain("after lunch");
    expect(gtaskMirrorFingerprint(tasks[0]!)).not.toBe(
      gtaskMirrorFingerprint({ id: "task-3", title: "Call Sam" }),
    );
  });

  it("serializes concurrent creates without duplicate posts", async () => {
    const store: MirrorStore = new Map();
    const port = createMockPort([{ id: "task-4", title: "Race task" }]);
    const prisma = createMockPrisma(store);
    const composio = new ComposioEmulator();
    for (const provider of ["GOOGLETASKS", "SLACK"] as const) {
      await composio.begin(
        { provider, redirectUrl: "http://example.test" },
        {
          ...ctx,
          operationId: "test",
          traceId: "test",
          signal: AbortSignal.timeout(1000),
        },
      );
    }
    const deps = { prisma: prisma as never, composio, port };

    const [first, second] = await Promise.all([
      syncGtasksSlackInbox(deps, ctx),
      syncGtasksSlackInbox(deps, ctx),
    ]);

    expect([first, second]).toEqual(
      expect.arrayContaining([
        { status: "ok", created: 1, updated: 0, unchanged: 0 },
        { status: "ok", created: 0, updated: 0, unchanged: 1 },
      ]),
    );
    expect(port.posts).toHaveLength(1);
  });

  it("retries an ambiguous ledger failure with the same Slack idempotency key", async () => {
    const store: MirrorStore = new Map();
    const port = createMockPort([{ id: "task-retry", title: "Retry task" }]);
    const prisma = createMockPrisma(store);
    prisma.integrationMirror.create.mockRejectedValueOnce(new Error("ledger unavailable"));
    const composio = new ComposioEmulator();
    for (const provider of ["GOOGLETASKS", "SLACK"] as const) {
      await composio.begin(
        { provider, redirectUrl: "http://example.test" },
        {
          ...ctx,
          operationId: "test",
          traceId: "test",
          signal: AbortSignal.timeout(1000),
        },
      );
    }
    const deps = { prisma: prisma as never, composio, port };

    const failed = await syncGtasksSlackInbox(deps, ctx);
    const retried = await syncGtasksSlackInbox(deps, ctx);

    expect(failed).toEqual({ status: "error", message: "ledger unavailable" });
    expect(retried).toEqual({ status: "ok", created: 1, updated: 0, unchanged: 0 });
    expect(port.posts).toHaveLength(1);
    expect(port.posts[0]?.clientMessageId).toBe(
      gtaskSlackClientMessageId(ctx.userId, "task-retry"),
    );
  });

  it("does not let an older concurrent delivery overwrite a newer revision", async () => {
    const store: MirrorStore = new Map();
    const taskId = "task-concurrent";
    store.set(mirrorKey(ctx.userId, taskId), {
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      fingerprint: gtaskMirrorFingerprint({ id: taskId, title: "Initial" }),
      sourceUpdatedAt: new Date("2026-08-18T09:00:00Z"),
      slackMessageTs: "ts-existing",
    });
    const prisma = createMockPrisma(store);
    const staleAtTarget = deferred();
    const releaseStale = deferred();
    prisma.bot.findFirst
      .mockImplementationOnce(async () => {
        staleAtTarget.resolve();
        await releaseStale.promise;
        return null;
      })
      .mockResolvedValueOnce(null);
    const stalePort = createMockPort([
      { id: taskId, title: "Version one", updated: "2026-08-18T10:00:00Z" },
    ]);
    const freshPort = createMockPort([
      { id: taskId, title: "Version two", updated: "2026-08-18T11:00:00Z" },
    ]);
    const composio = new ComposioEmulator();
    for (const provider of ["GOOGLETASKS", "SLACK"] as const) {
      await composio.begin(
        { provider, redirectUrl: "http://example.test" },
        {
          ...ctx,
          operationId: "test",
          traceId: "test",
          signal: AbortSignal.timeout(1000),
        },
      );
    }

    const staleSync = syncGtasksSlackInbox(
      { prisma: prisma as never, composio, port: stalePort },
      ctx,
    );
    await staleAtTarget.promise;
    const freshResult = await syncGtasksSlackInbox(
      { prisma: prisma as never, composio, port: freshPort },
      ctx,
    );
    releaseStale.resolve();
    const staleResult = await staleSync;

    expect(freshResult).toEqual({ status: "ok", created: 0, updated: 1, unchanged: 0 });
    expect(staleResult).toEqual({ status: "ok", created: 0, updated: 0, unchanged: 1 });
    expect(freshPort.updates[0]?.text).toContain("Version two");
    expect(stalePort.updates).toHaveLength(0);
    expect(store.get(mirrorKey(ctx.userId, taskId))).toMatchObject({
      fingerprint: gtaskMirrorFingerprint({ id: taskId, title: "Version two" }),
      sourceUpdatedAt: new Date("2026-08-18T11:00:00Z"),
    });
  });

  it("serializes concurrent revisions at the Slack delivery boundary", async () => {
    const store: MirrorStore = new Map();
    const taskId = "task-serialized";
    store.set(mirrorKey(ctx.userId, taskId), {
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      fingerprint: gtaskMirrorFingerprint({ id: taskId, title: "Initial" }),
      sourceUpdatedAt: new Date("2026-08-18T09:00:00Z"),
      slackMessageTs: "ts-existing",
    });
    const prisma = createMockPrisma(store);
    const staleUpdateStarted = deferred();
    const releaseStaleUpdate = deferred();
    const stalePort = createMockPort([
      { id: taskId, title: "Version one", updated: "2026-08-18T10:00:00Z" },
    ]);
    stalePort.updateSlackMessage = vi.fn(async (_ctx, messageTs, text) => {
      staleUpdateStarted.resolve();
      await releaseStaleUpdate.promise;
      stalePort.updates.push({ messageTs, text });
    });
    const freshPort = createMockPort([
      { id: taskId, title: "Version two", updated: "2026-08-18T11:00:00Z" },
    ]);
    const composio = new ComposioEmulator();
    for (const provider of ["GOOGLETASKS", "SLACK"] as const) {
      await composio.begin(
        { provider, redirectUrl: "http://example.test" },
        {
          ...ctx,
          operationId: "test",
          traceId: "test",
          signal: AbortSignal.timeout(1000),
        },
      );
    }

    const staleSync = syncGtasksSlackInbox(
      { prisma: prisma as never, composio, port: stalePort },
      ctx,
    );
    await staleUpdateStarted.promise;
    const freshSync = syncGtasksSlackInbox(
      { prisma: prisma as never, composio, port: freshPort },
      ctx,
    );
    await vi.waitFor(() => expect(prisma.$transaction).toHaveBeenCalledTimes(3));
    expect(freshPort.updates).toHaveLength(0);
    releaseStaleUpdate.resolve();
    const [staleResult, freshResult] = await Promise.all([staleSync, freshSync]);

    expect(staleResult).toEqual({ status: "ok", created: 0, updated: 1, unchanged: 0 });
    expect(freshResult).toEqual({ status: "ok", created: 0, updated: 1, unchanged: 0 });
    expect(freshPort.updates[0]?.text).toContain("Version two");
    expect(store.get(mirrorKey(ctx.userId, taskId))).toMatchObject({
      fingerprint: gtaskMirrorFingerprint({ id: taskId, title: "Version two" }),
      sourceUpdatedAt: new Date("2026-08-18T11:00:00Z"),
    });
  });

  it("does not start Slack delivery after lock wait exhausts its deadline", async () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      const store: MirrorStore = new Map();
      const prisma = createMockPrisma(store, [], {
        onQuery(query) {
          if (query.includes("pg_advisory_xact_lock(hashtextextended")) now += 66_000;
        },
      });
      const port = createMockPort([{ id: "task-expired", title: "Expired delivery" }]);
      const composio = new ComposioEmulator();
      for (const provider of ["GOOGLETASKS", "SLACK"] as const) {
        await composio.begin(
          { provider, redirectUrl: "http://example.test" },
          {
            ...ctx,
            operationId: "test",
            traceId: "test",
            signal: AbortSignal.timeout(1000),
          },
        );
      }

      const result = await syncGtasksSlackInbox({ prisma: prisma as never, composio, port }, ctx);

      expect(result.status).toBe("error");
      expect(port.posts).toHaveLength(0);
      expect(port.updates).toHaveLength(0);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("skips provider calls after workspace membership is removed", async () => {
    const store: MirrorStore = new Map();
    const prisma = createMockPrisma(store, [], { member: false });
    const port = createMockPort([{ id: "task-revoked", title: "Revoked task" }]);
    const listInboxTasks = vi.spyOn(port, "listInboxTasks");
    const connectionReady = vi.fn();

    const result = await syncGtasksSlackInbox(
      { prisma: prisma as never, composio: { connectionReady } as never, port },
      ctx,
    );

    expect(result).toEqual({ status: "skipped", reason: "connector_unavailable" });
    expect(connectionReady).not.toHaveBeenCalled();
    expect(listInboxTasks).not.toHaveBeenCalled();
    expect(port.posts).toHaveLength(0);
    expect(port.updates).toHaveLength(0);
  });

  it("stops Slack delivery when membership is removed after task listing", async () => {
    const store: MirrorStore = new Map();
    let member = true;
    const prisma = createMockPrisma(store, [], { member: () => member });
    const port = createMockPort([{ id: "task-revoked-late", title: "Revoked late" }]);
    port.listInboxTasks = vi.fn(async () => {
      member = false;
      return [
        {
          id: "task-revoked-late",
          title: "Revoked late",
          updated: "2026-08-18T10:00:00Z",
        },
      ];
    });
    const composio = new ComposioEmulator();
    for (const provider of ["GOOGLETASKS", "SLACK"] as const) {
      await composio.begin(
        { provider, redirectUrl: "http://example.test" },
        {
          ...ctx,
          operationId: "test",
          traceId: "test",
          signal: AbortSignal.timeout(1000),
        },
      );
    }

    const result = await syncGtasksSlackInbox({ prisma: prisma as never, composio, port }, ctx);

    expect(result).toEqual({ status: "skipped", reason: "connector_unavailable" });
    expect(port.posts).toHaveLength(0);
    expect(port.updates).toHaveLength(0);
  });

  it("stops Slack delivery when a connector is revoked during sync", async () => {
    const store: MirrorStore = new Map();
    let connectedProviders = [
      GTASKS_SLACK_ROUTING.composioProviders.googleTasks,
      GTASKS_SLACK_ROUTING.composioProviders.slack,
    ];
    const prisma = createMockPrisma(store, [], {
      connectedProviders: () => connectedProviders,
    });
    const reachedDelivery = deferred();
    const releaseDelivery = deferred();
    prisma.bot.findFirst.mockImplementationOnce(async () => {
      reachedDelivery.resolve();
      await releaseDelivery.promise;
      return null;
    });
    const port = createMockPort([{ id: "task-disconnected", title: "Disconnected task" }]);
    const composio = new ComposioEmulator();
    for (const provider of ["GOOGLETASKS", "SLACK"] as const) {
      await composio.begin(
        { provider, redirectUrl: "http://example.test" },
        {
          ...ctx,
          operationId: "test",
          traceId: "test",
          signal: AbortSignal.timeout(1000),
        },
      );
    }

    const sync = syncGtasksSlackInbox({ prisma: prisma as never, composio, port }, ctx);
    await reachedDelivery.promise;
    connectedProviders = [GTASKS_SLACK_ROUTING.composioProviders.slack];
    releaseDelivery.resolve();
    const result = await sync;

    expect(result).toEqual({ status: "skipped", reason: "connector_unavailable" });
    expect(port.posts).toHaveLength(0);
    expect(port.updates).toHaveLength(0);
  });

  it("holds workspace authorization while provider readiness and listing run", async () => {
    const store: MirrorStore = new Map();
    let member = true;
    const prisma = createMockPrisma(store, [], { member: () => member });
    const readinessStarted = deferred();
    const releaseReadiness = deferred();
    const connectionReady = vi.fn(async () => {
      readinessStarted.resolve();
      await releaseReadiness.promise;
      return true;
    });
    let memberDuringList: boolean | undefined;
    const port = createMockPort([{ id: "task-revocation-race", title: "Revocation race" }]);
    port.listInboxTasks = vi.fn(async () => {
      memberDuringList = member;
      return [
        {
          id: "task-revocation-race",
          title: "Revocation race",
          updated: "2026-08-18T10:00:00Z",
        },
      ];
    });

    const sync = syncGtasksSlackInbox(
      { prisma: prisma as never, composio: { connectionReady } as never, port },
      ctx,
    );
    await readinessStarted.promise;
    const revoke = prisma.$transaction(async () => {
      member = false;
    });
    releaseReadiness.resolve();
    const result = await sync;
    await revoke;

    expect(memberDuringList).toBe(true);
    expect(result).toEqual({ status: "skipped", reason: "connector_unavailable" });
    expect(port.posts).toHaveLength(0);
    expect(port.updates).toHaveLength(0);
  });

  it.each([undefined, "not-a-date"])(
    "fails closed when the task revision is %s",
    async (updated) => {
      const store: MirrorStore = new Map();
      const port: GtasksSlackPort = {
        listInboxTasks: vi.fn(async () => [
          { id: "task-invalid-revision", title: "Invalid revision", updated } as never,
        ]),
        postSlackMessage: vi.fn(),
        updateSlackMessage: vi.fn(),
      };
      const composio = new ComposioEmulator();
      for (const provider of ["GOOGLETASKS", "SLACK"] as const) {
        await composio.begin(
          { provider, redirectUrl: "http://example.test" },
          {
            ...ctx,
            operationId: "test",
            traceId: "test",
            signal: AbortSignal.timeout(1000),
          },
        );
      }

      const result = await syncGtasksSlackInbox(
        { prisma: createMockPrisma(store) as never, composio, port },
        ctx,
      );

      expect(result.status).toBe("error");
      expect(port.postSlackMessage).not.toHaveBeenCalled();
      expect(port.updateSlackMessage).not.toHaveBeenCalled();
    },
  );

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
      await composio.begin(
        { provider, redirectUrl: "http://example.test" },
        {
          ...ctx,
          operationId: "test",
          traceId: "test",
          signal: AbortSignal.timeout(1000),
        },
      );
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
