import type { MessageBlock } from "@rakazo/contracts";
import type * as db from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpReauthorizationRequiredError } from "./mcp-oauth.js";
import {
  needsMcpReauthorization,
  postMcpReconnectCard,
  reportExpiredMcpSignIn,
} from "./mcp-reconnect-card.js";

type Stored = { blocks: MessageBlock[]; clientNonce: string };
const stored = vi.hoisted(() => [] as { blocks: unknown; clientNonce: string }[]);
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof db>()),
  createThreadMessageInTransaction: vi.fn(async (_tx, input) => {
    // Newest first, as the recent-messages read orders them.
    stored.unshift(input);
    return { id: "card" };
  }),
  appendEventInTransaction: vi.fn(async () => ({ seq: 7, firstResponse: false })),
}));

const server = {
  id: "server",
  name: "Ledger",
  transport: "streamable_http",
  endpoint: "https://mcp.example.test/mcp",
};

function fixture(run: { threadId: string; spaceId: string } | null = defaultRun) {
  const tx = {
    $executeRaw: vi.fn(),
    message: {
      findMany: vi.fn(async () => stored),
      findFirst: vi.fn(
        async ({ where }: { where: { clientNonce: string } }) =>
          stored.find((message) => message.clientNonce === where.clientNonce) ?? null,
      ),
    },
  };
  const deps = {
    prisma: {
      run: { findUnique: vi.fn(async () => run) },
      $transaction: vi.fn(async (fn) => fn(tx)),
    },
    events: { notify: vi.fn() },
  } as unknown as Parameters<typeof postMcpReconnectCard>[0];
  return {
    deps,
    post: (runId = "run", target = server) =>
      postMcpReconnectCard(deps, { runId, botId: "bot" }, target),
  };
}
const defaultRun = { threadId: "chat", spaceId: "space" };

function setStatus(status: "connected" | "dismissed") {
  const card = stored[0] as Stored;
  card.blocks = card.blocks.map((block) => ({ ...block, status }) as MessageBlock);
}

beforeEach(() => {
  stored.length = 0;
  vi.clearAllMocks();
});

describe("MCP reconnect card", () => {
  it("leaves the server's authorization card in the run's chat", async () => {
    const f = fixture();
    expect(await f.post()).toBe(true);
    expect(stored).toEqual([
      {
        threadId: "chat",
        botId: "bot",
        runId: "run",
        role: "bot",
        blocks: [
          {
            kind: "mcp_approval",
            name: "Ledger",
            serverId: "server",
            transport: "streamable_http",
            endpoint: "https://mcp.example.test/mcp",
            needsOAuth: true,
            status: "pending",
          },
        ],
        clientNonce: "mcp-reconnect:server:run",
      },
    ]);
    expect(f.deps.events.notify).toHaveBeenCalledWith("chat", 7, undefined);
    expect(f.deps.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 20_000,
    });
  });

  it("posts one card while the last one is still open", async () => {
    const f = fixture();
    await f.post("run-1");
    expect(await f.post("run-2")).toBe(false);
    expect(stored).toHaveLength(1);
    expect(f.deps.events.notify).toHaveBeenCalledTimes(1);
  });

  it("does not ask again after Not now", async () => {
    const f = fixture();
    await f.post("run-1");
    setStatus("dismissed");
    expect(await f.post("run-2")).toBe(false);
    expect(stored).toHaveLength(1);
  });

  it("asks again when a sign-in the user renewed expires later", async () => {
    const f = fixture();
    await f.post("run-1");
    setStatus("connected");
    expect(await f.post("run-2")).toBe(true);
    expect(stored).toHaveLength(2);
  });

  it("does not repeat the card when the same run discovers the server again", async () => {
    const f = fixture();
    await f.post("run-1");
    setStatus("connected");
    expect(await f.post("run-1")).toBe(false);
    expect(stored).toHaveLength(1);
  });

  it("keeps another server's open card from blocking this one", async () => {
    const f = fixture();
    await f.post("run-1", { ...server, id: "other", name: "Other" });
    expect(await f.post("run-1")).toBe(true);
    expect(stored).toHaveLength(2);
  });

  it("posts nothing while a recent row that may have held the open card lost entries", async () => {
    const f = fixture();
    stored.unshift({ blocks: [{ kind: "text", text: "hi" }, "garbled"], clientNonce: "other" });
    expect(await f.post()).toBe(false);
    expect(stored).toHaveLength(1);
  });

  it("posts nothing for a run that no longer exists or a transport it cannot show", async () => {
    expect(await fixture(null).post()).toBe(false);
    expect(await fixture().post("run", { ...server, transport: "carrier-pigeon" })).toBe(false);
    expect(stored).toHaveLength(0);
  });
});

describe("reportExpiredMcpSignIn", () => {
  const expired = new McpReauthorizationRequiredError("server");
  const live = { runId: "run", botId: "bot", signal: new AbortController().signal };
  const report = (
    deps: ReturnType<typeof fixture>["deps"],
    context: Partial<typeof live> = {},
    error: unknown = expired,
  ) =>
    reportExpiredMcpSignIn(
      { prisma: deps.prisma, events: deps.events },
      { ...live, ...context },
      server,
      error,
    );

  it("leaves the card for an expired sign-in in a live run", async () => {
    const f = fixture();
    await report(f.deps);
    expect(stored).toHaveLength(1);
  });

  it("leaves nothing outside a live run or for another failure", async () => {
    const f = fixture();
    const stopped = new AbortController();
    stopped.abort();
    await report(f.deps, { runId: "" });
    await report(f.deps, { signal: stopped.signal });
    await report(f.deps, {}, new Error("fetch failed"));
    await reportExpiredMcpSignIn({ prisma: f.deps.prisma }, live, server, expired);
    expect(stored).toHaveLength(0);
  });

  it("keeps a failed post from reaching the run", async () => {
    const f = fixture();
    vi.mocked(f.deps.prisma.run.findUnique).mockRejectedValueOnce(new Error("database is down"));
    await expect(report(f.deps)).resolves.toBeUndefined();
  });
});

describe("needsMcpReauthorization", () => {
  it("finds an expired authorization behind wrapping errors only", () => {
    const expired = new McpReauthorizationRequiredError("server");
    expect(needsMcpReauthorization(expired)).toBe(true);
    expect(needsMcpReauthorization(new Error("connect failed", { cause: expired }))).toBe(true);
    expect(needsMcpReauthorization(new AggregateError([new Error("x"), expired]))).toBe(true);
    expect(needsMcpReauthorization(new Error("fetch failed"))).toBe(false);
    expect(needsMcpReauthorization("MCP authorization expired")).toBe(false);
  });
});
