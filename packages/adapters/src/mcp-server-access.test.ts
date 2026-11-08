import type { MessageBlock } from "@rakazo/contracts";
import { BUILTIN_TOOL_NAMES } from "@rakazo/contracts";
import { MCP_APPROVAL_CARD_WINDOW, toolRequiresApproval } from "@rakazo/core";
import { availableInSpace, itemSecretIn } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CORE_BUILTIN_TOOL_NAMES, isDeferredTool } from "./builtin-tool-bridge.js";
import { builtinAgentTools } from "./builtin-tools.js";
import { listMcpServersForBot, requestMcpServerFromTool } from "./mcp-server-access.js";
import type * as RunMessages from "./run-messages.js";
import { READ_ONLY_AGENT_TOOLS } from "./run-tool-selection.js";
import { integrationTools } from "./run-tools-integrations.js";

const persistMessageInTransaction = vi.fn(async (..._args: unknown[]) => ({
  message: {},
  eventSeq: 42,
  firstResponseRunId: "run-1",
}));

vi.mock("./run-messages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof RunMessages>()),
  persistMessageInTransaction: (...args: unknown[]) => persistMessageInTransaction(...args),
}));

const run = {
  id: "run-1",
  spaceId: "space-1",
  userId: "user-1",
  threadId: "thread-1",
  botId: "bot-1",
};
const lease = { runId: "run-1", owner: "worker-1", fence: 7 };

type Server = {
  id: string;
  spaceId: string;
  userId: string;
  slug: string;
  name: string;
  description: string;
  transport: string;
  endpoint: string | null;
  command: string | null;
  args: string[];
  env: Record<string, string>;
  headers: Record<string, boolean>;
  secretId: string | null;
  enabled: boolean;
  allSpaces: boolean;
  availableIn: string[];
  allBots: boolean;
  healthStatus: string;
  healthMessage: string | null;
  healthToolCount: number | null;
  healthCheckedAt: Date | null;
};

const server = (slug: string, extra: Partial<Server> = {}): Server => ({
  id: `id-${slug}`,
  spaceId: run.spaceId,
  userId: run.userId,
  slug,
  name: slug.toUpperCase(),
  description: `${slug} tools`,
  transport: "streamable_http",
  endpoint: `https://${slug}.example.test/mcp`,
  command: "never-listed-command",
  args: ["--never-listed-arg"],
  env: { NEVER_LISTED_ENV: "x" },
  headers: { "X-Never-Listed": true },
  secretId: "secret-never-listed",
  enabled: true,
  allSpaces: false,
  availableIn: [],
  allBots: false,
  healthStatus: "ok",
  healthMessage: "never-listed failure text",
  healthToolCount: 7,
  healthCheckedAt: new Date("2026-10-28T00:00:00Z"),
  ...extra,
});

type Message = { botId: string | null; role?: string; blocks: MessageBlock[] };

const userMessage = (value: string): Message => ({
  botId: null,
  role: "user",
  blocks: [{ kind: "text", text: value }],
});

const card = (serverId: string, status?: "pending" | "connected" | "dismissed") =>
  ({
    kind: "mcp_approval",
    name: "x",
    serverId,
    transport: "streamable_http",
    endpoint: null,
    needsOAuth: false,
    ...(status ? { status } : {}),
  }) as MessageBlock;

const text = (value: string): MessageBlock => ({ kind: "text", text: value });

/** Prisma's `select`: a column that is not selected is absent. */
function pick(row: Server, select: Record<string, boolean>) {
  return Object.fromEntries(Object.keys(select).map((key) => [key, row[key as keyof Server]]));
}

type Where = Record<string, unknown> & { OR?: Array<Record<string, unknown>> };

/** Evaluates the filters these queries use, including availableInSpace's OR. */
function matches(row: Server, where: Where): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === "OR") {
      return (value as Where[]).some((branch) => {
        if ("availableIn" in branch) {
          const some = (branch.availableIn as { some: { spaceId: string } }).some;
          return row.availableIn.includes(some.spaceId);
        }
        return matches(row, branch);
      });
    }
    return row[key as keyof Server] === value;
  });
}

type Assignment = { serverId: string; allowAllTools?: boolean; allowedTools?: unknown };

/**
 * `messages` is oldest first, as a thread reads. `materials` is each secret's stored OAuth
 * material by secret id. Every query asserts the exact scope it was given, so dropping a filter
 * fails the test that exercises it.
 */
function fakeDeps(
  servers: Server[],
  assigned: Array<string | Assignment> = [],
  messages: Message[] = [],
  materials: Record<string, unknown> = {},
) {
  const notify = vi.fn(async () => undefined);
  const tx: Record<string, unknown> = { marker: "tx", $queryRaw: vi.fn(async () => []) };
  const assignments = assigned.map((row) => (typeof row === "string" ? { serverId: row } : row));
  const scope = { botId: run.botId, spaceId: run.spaceId, userId: run.userId };
  const prisma = {
    mcpServer: {
      findMany: vi.fn(
        async (args: { where: Where; select: Record<string, boolean>; take?: number }) =>
          servers
            .filter((row) => matches(row, args.where))
            .sort((a, b) => a.name.localeCompare(b.name))
            .slice(0, args.take)
            .map((row) => pick(row, args.select)),
      ),
    },
    botMcpServer: {
      findMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
        expect(args.where).toEqual(scope);
        return assignments.map((row) => ({
          serverId: row.serverId,
          allowAllTools: row.allowAllTools ?? true,
          allowedTools: row.allowedTools ?? [],
        }));
      }),
      findFirst: vi.fn(async (args: { where: Record<string, unknown> & { serverId: string } }) => {
        expect(args.where).toEqual({ ...scope, serverId: args.where.serverId });
        return assignments.some((row) => row.serverId === args.where.serverId)
          ? { id: "assignment-1" }
          : null;
      }),
    },
    message: {
      findMany: vi.fn(async (args: Record<string, unknown>) => {
        expect(args).toEqual({
          where: { threadId: run.threadId },
          select: { botId: true, role: true, blocks: true },
          orderBy: { createdAt: "desc" },
          take: MCP_APPROVAL_CARD_WINDOW,
        });
        return [...messages]
          .reverse()
          .slice(0, MCP_APPROVAL_CARD_WINDOW)
          .map((message) => ({ role: "bot", ...message }));
      }),
    },
    secret: {
      findFirst: vi.fn(async (args: { where: { id: string } }) => {
        expect(args.where).toEqual({ id: args.where.id, ...itemSecretIn(run) });
        return args.where.id in materials ? { id: args.where.id, ciphertext: args.where.id } : null;
      }),
    },
    $transaction: vi.fn(async (fn: (client: unknown) => unknown) => fn(tx)),
  };
  tx.message = prisma.message;
  const secretStore = {
    load: vi.fn(async (ciphertext: string) => JSON.stringify(materials[ciphertext])),
  };
  const deps = { prisma, events: { notify }, runLease: lease, secretStore };
  return { deps: deps as never, prisma, notify, tx };
}

beforeEach(() => {
  persistMessageInTransaction.mockClear();
});

describe("list_mcp_servers", () => {
  it("lists the member's servers available in this Space and nobody else's", async () => {
    const { deps, prisma } = fakeDeps([
      server("own"),
      server("everywhere", { spaceId: "space-2", allSpaces: true }),
      server("shared-in", { spaceId: "space-2", availableIn: [run.spaceId] }),
      server("elsewhere", { spaceId: "space-2" }),
      server("off", { enabled: false }),
      server("theirs", { userId: "user-2" }),
    ]);
    const out = await listMcpServersForBot(deps, run, run.botId);
    expect(out.servers.map((row) => row.slug).sort()).toEqual(["everywhere", "own", "shared-in"]);
    expect(prisma.mcpServer.findMany.mock.calls[0]?.[0].where).toEqual({
      enabled: true,
      ...availableInSpace(run),
    });
  });

  it("never lists an endpoint, launch detail, credential or health message", async () => {
    const { deps } = fakeDeps([server("own")]);
    const out = await listMcpServersForBot(deps, run, run.botId);
    expect(out.servers).toEqual([
      {
        server_id: "id-own",
        slug: "own",
        name: "OWN",
        description: "own tools",
        transport: "streamable_http",
        status: "requestable",
        health: "ok",
        tool_count: 7,
        checked_at: "2026-10-28T00:00:00.000Z",
      },
    ]);
    const listed = JSON.stringify(out);
    for (const secret of ["example.test", "never-listed", "secret", "X-Never"]) {
      expect(listed).not.toContain(secret);
    }
  });

  it("normalizes an unrecognized health status", async () => {
    const { deps } = fakeDeps([server("own", { healthStatus: "weird" })]);
    const [row] = (await listMcpServersForBot(deps, run, run.botId)).servers;
    expect(row?.health).toBe("unknown");
  });

  it("marks shared and assigned servers available, open cards pending, and the rest requestable", async () => {
    const { deps } = fakeDeps(
      [
        server("all", { allBots: true }),
        server("mine"),
        server("asked"),
        server("legacy"),
        server("connected"),
        server("dismissed"),
        server("other-bot"),
        server("never"),
      ],
      ["id-mine"],
      [
        { botId: run.botId, blocks: [text("hi"), card("id-asked", "pending")] },
        { botId: run.botId, blocks: [card("id-legacy")] },
        { botId: run.botId, blocks: [card("id-connected", "connected")] },
        { botId: run.botId, blocks: [card("id-dismissed", "dismissed")] },
        { botId: "bot-2", blocks: [card("id-other-bot", "pending")] },
      ],
    );
    const out = await listMcpServersForBot(deps, run, run.botId);
    expect(Object.fromEntries(out.servers.map((row) => [row.slug, row.status]))).toEqual({
      all: "available",
      mine: "available",
      asked: "pending",
      legacy: "pending",
      connected: "requestable",
      dismissed: "requestable",
      "other-bot": "requestable",
      never: "requestable",
    });
  });
  it("counts only the allowed tools of a narrowed assignment", async () => {
    const { deps } = fakeDeps(
      [server("narrow"), server("whole"), server("shared", { allBots: true })],
      [{ serverId: "id-narrow", allowAllTools: false, allowedTools: ["a", "b"] }, "id-whole"],
    );
    const out = await listMcpServersForBot(deps, run, run.botId);
    expect(Object.fromEntries(out.servers.map((row) => [row.slug, row.tool_count]))).toEqual({
      narrow: 2,
      whole: 7,
      shared: 7,
    });
  });
  it("caps a narrowed count at the probed tools and ignores malformed allowlists", async () => {
    const { deps } = fakeDeps(
      [
        server("stale", { healthToolCount: 2 }),
        server("broken"),
        server("unprobed", { healthToolCount: null }),
      ],
      [
        { serverId: "id-stale", allowAllTools: false, allowedTools: ["a", "b", "gone", "a"] },
        { serverId: "id-broken", allowAllTools: false, allowedTools: null },
        { serverId: "id-unprobed", allowAllTools: false, allowedTools: ["a", 3, "b"] },
      ],
    );
    const out = await listMcpServersForBot(deps, run, run.botId);
    expect(Object.fromEntries(out.servers.map((row) => [row.slug, row.tool_count]))).toEqual({
      stale: 2,
      broken: 0,
      unprobed: 2,
    });
  });
});

describe("request_mcp_server", () => {
  it("does nothing for a server the bot already has", async () => {
    const { deps, notify } = fakeDeps(
      [server("all", { allBots: true }), server("mine")],
      ["id-mine"],
    );
    for (const args of [{ server_id: "id-all" }, { slug: "mine" }]) {
      expect(await requestMcpServerFromTool(deps, run, run.botId, args)).toMatchObject({
        ok: true,
        status: "available",
      });
    }
    expect(persistMessageInTransaction).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("posts one approval card with the stored endpoint under the run's lease", async () => {
    const { deps, notify, tx } = fakeDeps([
      server("git", { secretId: null, healthStatus: "unknown" }),
    ]);
    const out = await requestMcpServerFromTool(deps, run, run.botId, { slug: "git" });
    expect(out).toMatchObject({ ok: true, server_id: "id-git", status: "pending" });
    expect((out as { next_step: string }).next_step).toContain("authorize");
    expect(persistMessageInTransaction).toHaveBeenCalledTimes(1);
    expect(persistMessageInTransaction).toHaveBeenCalledWith(
      tx,
      run,
      "bot",
      [
        {
          kind: "mcp_approval",
          name: "GIT",
          serverId: "id-git",
          transport: "streamable_http",
          endpoint: "https://git.example.test/mcp",
          needsOAuth: true,
          status: "pending",
        },
      ],
      undefined,
      undefined,
      false,
      lease,
    );
    expect(notify).toHaveBeenCalledWith("thread-1", 42, "run-1");
  });

  it("checks for an open card and posts under one lock on the thread, bot and server", async () => {
    const { deps, prisma, tx } = fakeDeps([server("git")]);
    const order: string[] = [];
    (tx.$queryRaw as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push("lock");
      return [];
    });
    prisma.message.findMany.mockImplementationOnce(async () => {
      order.push("scan");
      return [];
    });
    persistMessageInTransaction.mockImplementationOnce(async () => {
      order.push("post");
      return { message: {}, eventSeq: 42, firstResponseRunId: "run-1" };
    });
    await requestMcpServerFromTool(deps, run, run.botId, { slug: "git" });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["lock", "scan", "post"]);
    expect((tx.$queryRaw as ReturnType<typeof vi.fn>).mock.calls[0]?.slice(1)).toEqual([
      `mcp-approval-request:${run.threadId}:${run.botId}:id-git`,
    ]);
  });

  it("asks for approval, not authorization, when the server has a stored credential or is local", async () => {
    const { deps } = fakeDeps([
      server("token"),
      server("local", { transport: "stdio", endpoint: null, secretId: null }),
    ]);
    for (const slug of ["token", "local"]) {
      const out = await requestMcpServerFromTool(deps, run, run.botId, { slug });
      expect((out as { next_step: string }).next_step).toContain("approve it");
    }
    const needsOAuth = persistMessageInTransaction.mock.calls.map(
      (call) => (call[3] as Array<{ needsOAuth: boolean }>)[0]?.needsOAuth,
    );
    expect(needsOAuth).toEqual([false, false]);
  });

  it("asks for approval when a server with no credential is working", async () => {
    const { deps } = fakeDeps([server("public", { secretId: null, healthStatus: "ok" })]);
    const out = await requestMcpServerFromTool(deps, run, run.botId, { slug: "public" });
    expect((out as { next_step: string }).next_step).toContain("approve it");
    expect(persistMessageInTransaction.mock.calls[0]?.[3]).toMatchObject([{ needsOAuth: false }]);
  });

  it("asks for authorization from the stored sign-in state, as settings does", async () => {
    const { deps } = fakeDeps(
      [
        // Tokens dropped or a sign-in abandoned: the secret keeps only the OAuth state.
        server("reconnect", { secretId: "s-reconnect" }),
        // A client registered by hand that never signed in.
        server("client", { secretId: "s-client", healthStatus: "unknown" }),
        // Signed in, but its last check failed: signing in again would not help.
        server("signed-in", { secretId: "s-tokens", healthStatus: "error" }),
      ],
      [],
      [],
      {
        "s-reconnect": { oauth: { clientInformation: { client_id: "c" } } },
        "s-client": { oauthClient: { client_id: "c" } },
        "s-tokens": { oauth: { tokens: { access_token: "t", token_type: "bearer" } } },
      },
    );
    for (const slug of ["reconnect", "client", "signed-in"]) {
      await requestMcpServerFromTool(deps, run, run.botId, { slug });
    }
    const needsOAuth = persistMessageInTransaction.mock.calls.map(
      (call) => (call[3] as Array<{ needsOAuth: boolean }>)[0]?.needsOAuth,
    );
    expect(needsOAuth).toEqual([true, true, false]);
  });

  it("returns the open card instead of posting another", async () => {
    for (const open of [card("id-git", "pending"), card("id-git")]) {
      const { deps, notify } = fakeDeps(
        [server("git")],
        [],
        [{ botId: run.botId, blocks: [open] }],
      );
      const out = await requestMcpServerFromTool(deps, run, run.botId, { server_id: "id-git" });
      expect(out).toMatchObject({ ok: true, server_id: "id-git", status: "pending" });
      expect((out as { next_step: string }).next_step).toContain("already in the chat");
      expect(notify).not.toHaveBeenCalled();
    }
    expect(persistMessageInTransaction).not.toHaveBeenCalled();
  });

  it("posts a new card after a connection was removed, for another bot's card, or past the window", async () => {
    const newer = Array.from({ length: 100 }, () => ({ botId: null, blocks: [text("later")] }));
    for (const messages of [
      [{ botId: run.botId, blocks: [card("id-git", "connected")] }],
      [{ botId: "bot-2", blocks: [card("id-git", "pending")] }],
      [{ botId: run.botId, blocks: [card("id-git", "pending")] }, ...newer],
    ]) {
      const { deps } = fakeDeps([server("git")], [], messages);
      expect(
        await requestMcpServerFromTool(deps, run, run.botId, { server_id: "id-git" }),
      ).toMatchObject({ status: "pending" });
    }
    expect(persistMessageInTransaction).toHaveBeenCalledTimes(3);
  });

  it("respects a dismissed card until the user writes again", async () => {
    for (const messages of [
      [{ botId: run.botId, blocks: [card("id-git", "dismissed")] }],
      [
        userMessage("use git"),
        { botId: run.botId, blocks: [card("id-git", "connected")] },
        { botId: run.botId, blocks: [card("id-git", "dismissed")] },
        { botId: "bot-2", blocks: [text("other bot")] },
      ],
    ]) {
      const { deps, notify } = fakeDeps([server("git")], [], messages);
      const out = await requestMcpServerFromTool(deps, run, run.botId, { server_id: "id-git" });
      expect(out).toMatchObject({ ok: true, server_id: "id-git", status: "declined" });
      expect((out as { next_step: string }).next_step).toContain("unless the user brings it up");
      expect(notify).not.toHaveBeenCalled();
    }
    expect(persistMessageInTransaction).not.toHaveBeenCalled();

    const { deps } = fakeDeps(
      [server("git")],
      [],
      [{ botId: run.botId, blocks: [card("id-git", "dismissed")] }, userMessage("try again")],
    );
    expect(
      await requestMcpServerFromTool(deps, run, run.botId, { server_id: "id-git" }),
    ).toMatchObject({ status: "pending" });
    expect(persistMessageInTransaction).toHaveBeenCalledTimes(1);
  });

  it("uses the one enabled server among several with a slug", async () => {
    const { deps } = fakeDeps([
      server("twin", { id: "id-twin-off", enabled: false }),
      server("twin", { id: "id-twin-on", spaceId: "space-2", allSpaces: true }),
    ]);
    expect(await requestMcpServerFromTool(deps, run, run.botId, { slug: "twin" })).toMatchObject({
      server_id: "id-twin-on",
      status: "pending",
    });
  });

  it("refuses an empty, unknown, ambiguous or disabled request", async () => {
    const { deps } = fakeDeps([
      server("off", { enabled: false }),
      server("twin", { id: "id-twin-1" }),
      server("twin", { id: "id-twin-2", spaceId: "space-2", allSpaces: true }),
      server("theirs", { userId: "user-2" }),
    ]);
    const refusals = await Promise.all(
      [
        {},
        { server_id: "  " },
        { server_id: "nope" },
        { slug: "theirs" },
        { slug: "twin" },
        { slug: "off" },
      ].map((args) => requestMcpServerFromTool(deps, run, run.botId, args)),
    );
    expect(refusals.map((out) => Object.keys(out))).toEqual(Array(6).fill(["error"]));
    expect(refusals.map((out) => (out as { error: string }).error)).toEqual([
      expect.stringContaining("Provide a server_id or slug"),
      expect.stringContaining("Provide a server_id or slug"),
      expect.stringContaining("No MCP server matches"),
      expect.stringContaining("No MCP server matches"),
      expect.stringContaining("More than one MCP server"),
      expect.stringContaining("turned off"),
    ]);
    expect(persistMessageInTransaction).not.toHaveBeenCalled();
  });
});

describe("MCP server access tools", () => {
  it("are declared, handled, deferred and need no approval", () => {
    for (const name of ["list_mcp_servers", "request_mcp_server"]) {
      expect(BUILTIN_TOOL_NAMES).toContain(name);
      expect(builtinAgentTools.some((tool) => tool.name === name)).toBe(true);
      expect(typeof integrationTools[name]).toBe("function");
      expect(CORE_BUILTIN_TOOL_NAMES.has(name)).toBe(false);
      expect(isDeferredTool(name)).toBe(true);
      expect(toolRequiresApproval(name, false)).toBe(false);
    }
    const definition = (name: string) => builtinAgentTools.find((tool) => tool.name === name);
    expect(definition("list_mcp_servers")?.readOnly).toBe(true);
    // The listing is offered even when the request tool is turned off.
    expect(definition("list_mcp_servers")?.description).not.toContain("request_mcp_server");
    expect(definition("request_mcp_server")?.readOnly).toBeUndefined();
    expect(READ_ONLY_AGENT_TOOLS.has("list_mcp_servers")).toBe(true);
    expect(READ_ONLY_AGENT_TOOLS.has("request_mcp_server")).toBe(false);
  });
});
