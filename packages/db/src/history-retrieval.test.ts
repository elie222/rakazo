import { describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "./client.js";
import { historyMessageText, readHistory, searchHistory } from "./history-retrieval.js";

const scope = { spaceId: "space", userId: "user", threadId: "thread", botId: "bot" };
const row = (seq: number, text = "Use batch exports") => ({
  id: `message-${seq}`,
  seq,
  role: "user",
  blocks: [{ kind: "text", text }],
  createdAt: new Date("2026-01-01T00:00:00Z"),
  runId: null,
  replyToMessageId: null,
});
function db() {
  const mock = {
    $queryRaw: vi.fn(),
    run: { findMany: vi.fn().mockResolvedValue([]) },
    artifact: { findMany: vi.fn().mockResolvedValue([]) },
  };
  return { mock, prisma: mock as unknown as PrismaClient };
}
function sql(mock: ReturnType<typeof db>["mock"], call = 0) {
  return mock.$queryRaw.mock.calls[call]![0] as Prisma.Sql;
}
describe("local history retrieval", () => {
  it("bounds search excerpts and pages by stable sequence", async () => {
    const { mock, prisma } = db();
    mock.$queryRaw.mockResolvedValue([row(10), row(9), row(8)]);
    const result = await searchHistory(prisma, scope, {
      query: "exports",
      limit: 2,
      beforeSeq: 20,
    });
    expect(result.messages.map((message) => message.seq)).toEqual([10, 9]);
    expect(result.nextBeforeSeq).toBe(9);
    expect(result.untrusted).toBe(true);
    expect(sql(mock).sql).toContain("plainto_tsquery");
    expect(sql(mock).values).toEqual(
      expect.arrayContaining(["space", "user", "bot", "thread", "exports", 20, 3]),
    );
  });
  it("keeps an unfinished broad query actionable after an exhausted narrower query", async () => {
    const { mock, prisma } = db();
    mock.$queryRaw
      .mockResolvedValueOnce([row(7), row(6), row(5), row(4), row(3), row(2)])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([row(2), row(1, "Aurora original label ORBIT-731")]);
    const historicalScope = { ...scope, searchBeforeSeq: 50 };
    const broad = await searchHistory(prisma, historicalScope, {
      query: " Aurora ",
      limit: 20,
      beforeSeq: 9999,
      after: "2026-01-01T00:00:00Z",
      before: "2026-01-02T00:00:00Z",
    });
    expect(broad.coverage).toEqual({ scope: "requested_query_and_range", status: "partial" });
    expect(broad.query).toBe("Aurora");
    expect(broad.nextSearch).toEqual({
      query: "Aurora",
      limit: 5,
      beforeSeq: 3,
      after: "2026-01-01T00:00:00Z",
      before: "2026-01-02T00:00:00Z",
    });
    expect(sql(mock).values).toContain(50);
    const narrow = await searchHistory(prisma, historicalScope, { query: "extraction" });
    expect(narrow).toMatchObject({
      query: "extraction",
      coverage: {
        scope: "requested_query_and_range",
        status: "exhausted",
      },
      nextBeforeSeq: null,
      nextSearch: null,
    });
    const older = await searchHistory(prisma, historicalScope, broad.nextSearch!);
    expect(older.messages.some((message) => message.text.includes("ORBIT-731"))).toBe(true);
    expect(older.coverage.status).toBe("exhausted");
    expect(sql(mock, 2).values).toContain(3);
    expect(mock.$queryRaw).toHaveBeenCalledTimes(3);
  });
  it("bounds Unicode search pages without discarding the continuation or original offsets", async () => {
    const { mock, prisma } = db();
    const query = "星".repeat(250);
    mock.$queryRaw.mockResolvedValue(
      Array.from({ length: 6 }, (_, index) => row(10 - index, query + "界".repeat(1000))),
    );
    const result = await searchHistory(prisma, scope, { query });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(10000);
    expect(result.nextSearch).toEqual({ query, beforeSeq: 6, limit: 5 });
    expect(result.messages).toHaveLength(5);
    for (const message of result.messages) {
      expect(message.text).toBe(
        (query + "界".repeat(1000)).slice(
          message.textOffset,
          message.textOffset + message.text.length,
        ),
      );
      expect(message.nextTextOffset).toBe(message.textOffset + message.text.length);
    }
  });
  it("keeps non-ASCII multi-query attribution and continuation inside the byte budget", async () => {
    const { mock, prisma } = db();
    const queries = ["星".repeat(499), `${"界".repeat(498)}xx`];
    mock.$queryRaw.mockResolvedValue(
      Array.from({ length: 6 }, (_, i) => ({
        ...row(i, queries.join(" ") + "界".repeat(1000)),
        threadId: "thread",
        chatName: "History",
        matchedQueryIndexes: [0, 1],
      })),
    );
    const result = await searchHistory(prisma, scope, { queries });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(10000);
    expect(result.nextSearch).toMatchObject({ queries, offset: 5 });
    expect(result.messages).toHaveLength(5);
    mock.$queryRaw.mockClear();
    await expect(
      searchHistory(prisma, scope, { queries: [`${queries[0]!}x`, queries[1]!] }),
    ).rejects.toThrow("3000 UTF-8 bytes");
    expect(mock.$queryRaw).not.toHaveBeenCalled();
  });
  it("points search excerpts at the matching portion of an oversized message", async () => {
    const { mock, prisma } = db();
    mock.$queryRaw.mockResolvedValue([
      row(1, `${"filler ".repeat(1000)}ledger-indexer final outcome`),
    ]);
    const result = await searchHistory(prisma, scope, { query: "ledger-indexer" });
    expect(result.messages[0]!.text).toContain("ledger-indexer");
    expect(result.messages[0]!.textOffset).toBeGreaterThan(6000);
    const original = `${"filler ".repeat(1000)}ledger-indexer final outcome`;
    expect(result.messages[0]!.text).toBe(
      original.slice(
        result.messages[0]!.textOffset,
        result.messages[0]!.textOffset + result.messages[0]!.text.length,
      ),
    );
  });
  it("restricts channel inputs and bot output using the run source, including neighbors", async () => {
    const { mock, prisma } = db();
    mock.$queryRaw.mockResolvedValueOnce([row(4)]).mockResolvedValueOnce([row(3), row(4)]);
    await readHistory(prisma, { ...scope, channelId: "group-channel" }, { messageId: "message-4" });
    for (const call of [0, 1]) {
      expect(sql(mock, call).sql).toContain('source.id = r."sourceMessageId"');
      expect(sql(mock, call).sql).toContain('source."threadId" = t.id');
      expect(sql(mock, call).values).toContain(
        JSON.stringify([{ kind: "channel_message", channelId: "group-channel" }]),
      );
    }
    expect(mock.run.findMany.mock.calls[0]![0].where).toMatchObject({
      ...scope,
      sourceMessage: { threadId: "thread", role: "user" },
    });
  });
  it("does not retrieve runs or artifacts for a missing, cleared, or inaccessible anchor", async () => {
    const { mock, prisma } = db();
    mock.$queryRaw.mockResolvedValue([]);
    expect((await readHistory(prisma, scope, { messageId: "foreign" })).messages).toEqual([]);
    expect(mock.run.findMany).not.toHaveBeenCalled();
    expect(mock.artifact.findMany).not.toHaveBeenCalled();
    expect(sql(mock).sql).toContain('t."spaceId" =');
    expect(sql(mock).sql).toContain('t."userId" =');
    expect(sql(mock).sql).toContain('t."botId" =');
  });
  it("reuses originals without inference and invalidates snapshots when content changes", async () => {
    const { mock, prisma } = db();
    mock.$queryRaw.mockResolvedValueOnce([row(1)]).mockResolvedValueOnce([row(1)]);
    const first = await readHistory(prisma, scope, { messageId: "message-1" });
    mock.$queryRaw
      .mockResolvedValueOnce([row(1)])
      .mockResolvedValueOnce([row(1, "Use streaming exports")]);
    const second = await readHistory(prisma, scope, { messageId: "message-1" });
    expect(first.snapshots[0]!.source).toBe("original");
    expect(first.snapshots[0]!.version).not.toBe(second.snapshots[0]!.version);
    expect(second.snapshots[0]!.topic).toBe("Use streaming exports");
  });
  it("pages inside an oversized original without dumping the entire message", async () => {
    const { mock, prisma } = db();
    mock.$queryRaw.mockResolvedValue([
      row(1, `${"a".repeat(2000)}distant exact fact${"b".repeat(2000)}`),
    ]);
    const result = await readHistory(prisma, scope, { messageId: "message-1", textOffset: 2000 });
    expect(result.messages[0]!.text).toContain("distant exact fact");
    expect(result.messages[0]!.text.length).toBe(2000);
    expect(result.messages[0]!.nextTextOffset).toBe(4000);
    expect(result.messages[0]!.textOffset).toBe(2000);
    expect(mock.$queryRaw).toHaveBeenCalledTimes(1);
  });
  it("reconstructs UTF-16 pages without splitting surrogate pairs", async () => {
    const { mock, prisma } = db();
    const text = `${"a".repeat(1999)}😀${"b".repeat(2001)}`;
    mock.$queryRaw.mockResolvedValue([row(1, text)]);
    let offset: number | null = 0;
    let reconstructed = "";
    for (let page = 0; offset !== null && page < 10; page++) {
      const result = await readHistory(prisma, scope, {
        messageId: "message-1",
        textOffset: offset,
      });
      const message = result.messages[0]!;
      expect(message.textOffset).toBe(offset);
      expect(Buffer.from(message.text).toString()).toBe(message.text);
      reconstructed += message.text;
      if (message.nextTextOffset !== null) {
        expect(message.nextTextOffset).toBe(offset + message.text.length);
        expect(message.nextTextOffset).toBeGreaterThan(offset);
      }
      offset = message.nextTextOffset;
    }
    expect(offset).toBeNull();
    expect(reconstructed).toBe(text);

    const middle = await readHistory(prisma, scope, { messageId: "message-1", textOffset: 2000 });
    expect(middle.messages[0]!.textOffset).toBe(1999);
    expect(middle.messages[0]!.text.startsWith("😀")).toBe(true);
  });
  it("keeps search excerpt starts and snapshot topics on Unicode boundaries", async () => {
    const { mock, prisma } = db();
    const text = `${"z".repeat(10)}😀${"a".repeat(39)}needle`;
    mock.$queryRaw.mockResolvedValue([row(1, text)]);
    const found = await searchHistory(prisma, scope, { query: "needle" });
    expect(found.messages[0]!.textOffset).toBe(10);
    expect(found.messages[0]!.text).toBe(text.slice(10));
    expect(Buffer.from(found.messages[0]!.text).toString()).toBe(found.messages[0]!.text);

    const topic = `${"x".repeat(199)}😀tail`;
    mock.$queryRaw.mockResolvedValue([row(1, topic)]);
    const result = await readHistory(prisma, scope, { messageId: "message-1" });
    expect(result.snapshots[0]!.topic).toBe("x".repeat(199));
    expect(Buffer.from(result.snapshots[0]!.topic).toString()).toBe(result.snapshots[0]!.topic);
  });
  it("preserves surrogate pairs while reducing Unicode pages to the response budget", async () => {
    const { mock, prisma } = db();
    const text = `${"é".repeat(399)}😀${"é".repeat(399)}!`;
    mock.$queryRaw.mockResolvedValue(Array.from({ length: 5 }, (_, i) => row(10 - i, text)));
    const result = await searchHistory(prisma, scope, { query: "é".repeat(500) });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(10000);
    expect(result.messages.some((message) => message.text.length < 800)).toBe(true);
    for (const message of result.messages) {
      expect(Buffer.from(message.text).toString()).toBe(message.text);
      expect(message.nextTextOffset).toBe(message.textOffset + message.text.length);
    }
  });
  it("shortens another reference when a single surrogate pair cannot be reduced", async () => {
    const { mock, prisma } = db();
    const first = { ...row(2, "😀"), id: "" };
    const second = { ...row(1, "aa"), id: "other" };
    const ref = (r: typeof first, text: string) => ({
      messageId: r.id,
      seq: r.seq,
      role: r.role,
      createdAt: r.createdAt.toISOString(),
      runId: r.runId,
      replyToMessageId: r.replyToMessageId,
      text,
      textOffset: 0,
      nextTextOffset: null,
      truncated: false,
    });
    const unbounded = {
      untrusted: true,
      query: "a",
      coverage: { scope: "requested_query_and_range", status: "exhausted" },
      messages: [ref(first, "😀"), ref(second, "aa")],
      nextBeforeSeq: null,
      nextSearch: null,
    };
    first.id = "i".repeat(10001 - Buffer.byteLength(JSON.stringify(unbounded)));
    mock.$queryRaw.mockResolvedValue([first, second]);
    const result = await searchHistory(prisma, scope, { query: "a" });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(10000);
    expect(result.messages[0]!.text).toBe("😀");
    expect(result.messages[1]!.text).toBe("a");
    expect(result.messages[1]!.nextTextOffset).toBe(1);
  });
  it("keeps the first complete character when halving would produce an empty reference", async () => {
    const { mock, prisma } = db();
    const message = { ...row(1, "😀a"), id: "" };
    const reference = {
      messageId: "",
      seq: message.seq,
      role: message.role,
      createdAt: message.createdAt.toISOString(),
      runId: message.runId,
      replyToMessageId: message.replyToMessageId,
      text: "😀a",
      textOffset: 0,
      nextTextOffset: null,
      truncated: false,
    };
    const unbounded = {
      untrusted: true,
      query: "a",
      coverage: { scope: "requested_query_and_range", status: "exhausted" },
      messages: [reference],
      nextBeforeSeq: null,
      nextSearch: null,
    };
    message.id = "i".repeat(10001 - Buffer.byteLength(JSON.stringify(unbounded)));
    mock.$queryRaw.mockResolvedValue([message]);
    const result = await searchHistory(prisma, scope, { query: "a" });
    expect(result.messages[0]!.text).toBe("😀");
    expect(result.messages[0]!.nextTextOffset).toBe(2);
  });
  it("fails when metadata leaves no room for even one complete character", async () => {
    const { mock, prisma } = db();
    mock.$queryRaw.mockResolvedValue([{ ...row(1, "😀"), id: "i".repeat(10000) }]);
    await expect(searchHistory(prisma, scope, { query: "a" })).rejects.toThrow(
      "History metadata exceeds response budget",
    );
  });
  it("omits non-text secrets, progress, and commands from retrieved text", () => {
    expect(
      historyMessageText([
        { kind: "text", text: "visible" },
        { kind: "secret_prompt", text: "hidden" },
        { kind: "progress", text: "trace" },
      ]),
    ).toBe("visible");
  });
  it("validates dates, query size and pagination before accessing the database", async () => {
    const { mock, prisma } = db();
    await expect(searchHistory(prisma, scope, { query: "x", before: "invalid" })).rejects.toThrow(
      "Invalid history date",
    );
    await expect(searchHistory(prisma, scope, { query: "x", limit: 0 })).rejects.toThrow();
    await expect(searchHistory(prisma, scope, { query: "x", beforeSeq: -1 })).rejects.toThrow();
    await expect(searchHistory(prisma, scope, { query: " " })).rejects.toThrow();
    expect(mock.$queryRaw).not.toHaveBeenCalled();
  });
});
