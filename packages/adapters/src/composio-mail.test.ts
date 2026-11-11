import type { AdapterContext, ConnectorProvider } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { ComposioConnector } from "./composio-connector.js";
import { FakeComposioClient } from "./composio-fake.js";
import { CONNECTED_MAIL_READ_TOOLS, composioMailSource } from "./composio-mail.js";
import { connectedContext } from "./connection-context.js";
import { ConnectorRegistry } from "./connector-registry.js";

const USER = "user-1";
/** What one read may hold, in bytes, unless a test is about that. */
const maxBytes = 1024 * 1024;

function rawMail(from: string, subject: string, date: Date, text = "Your code is 482913\r\n") {
  return [
    `From: Sign-in <${from}>`,
    "To: me@example.test",
    `Subject: ${subject}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${subject.replace(/\W/g, "")}@${from.split("@")[1]}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    text,
  ].join("\r\n");
}

function setup() {
  const client = new FakeComposioClient();
  const accountId = client.connect(USER, "GMAIL");
  const connector = new ComposioConnector({ client });
  const registry = new ConnectorRegistry([connector]);
  const row = {
    id: "connection-1",
    connectorId: "composio",
    provider: "GMAIL",
    displayName: "Mail",
    providerRef: accountId,
  };
  const source = composioMailSource(registry);
  const reader = source.readerFor({ ...row, externalId: row.provider })!;
  const context: AdapterContext = {
    operationId: "read-1",
    traceId: "read-1",
    spaceId: "space-1",
    userId: USER,
    botId: "bot-1",
    signal: AbortSignal.timeout(3000),
    ...connectedContext([row]),
  };
  return { client, registry, source, reader, context };
}

describe("composioMailSource", () => {
  it("reads only the mail connections it knows", () => {
    const { source } = setup();
    const connection = { id: "c", connectorId: "composio", externalId: "GMAIL", displayName: "" };
    expect(source.readerFor(connection)).toBeDefined();
    expect(source.readerFor({ ...connection, externalId: "github" })).toBeUndefined();
    expect(source.readerFor({ ...connection, connectorId: "pipedream" })).toBeUndefined();
  });

  it("names the mailbox it reads", async () => {
    const { reader, context } = setup();
    await expect(reader.mailbox(context)).resolves.toBe("me@example.test");
  });

  it("returns the site's newest mail in the window as it was received, newest first", async () => {
    const { client, reader, context } = setup();
    // Mail dates are whole seconds.
    const now = Math.floor(Date.now() / 1000) * 1000;
    const old = rawMail("no-reply@example.com", "Old code", new Date(now - 3 * 86_400_000));
    const first = rawMail("no-reply@example.com", "First code", new Date(now - 60_000));
    const second = rawMail("no-reply@example.com", "Second code", new Date(now - 30_000));
    const other = rawMail("no-reply@other.example", "Other code", new Date(now - 20_000));
    for (const raw of [old, first, second, other]) client.receiveMail(USER, raw);

    const { messages } = await reader.recent(context, {
      fromDomain: "example.com",
      after: new Date(now - 86_400_000),
      limit: 5,
      maxBytes,
    });

    expect(messages.map((message) => new TextDecoder().decode(message.raw))).toEqual([
      second,
      first,
    ]);
    expect(messages.map((message) => message.receivedAt?.getTime())).toEqual([
      now - 30_000,
      now - 60_000,
    ]);
    expect(new Set(messages.map((message) => message.id)).size).toBe(2);
  });

  it("reads at most the limit a page, and names the next page while there is more", async () => {
    const { client, reader, context } = setup();
    for (let i = 0; i < 7; i++)
      client.receiveMail(USER, rawMail("a@example.com", `Code ${i}`, new Date(Date.now() - i)));
    const query = {
      fromDomain: "example.com",
      after: new Date(Date.now() - 3_600_000),
      limit: 5,
      maxBytes,
    };
    const first = await reader.recent(context, query);
    expect(first.messages).toHaveLength(5);
    expect(first.next).toBeDefined();
    const second = await reader.recent(context, { ...query, page: first.next });
    expect(second.messages).toHaveLength(2);
    expect(second.next).toBeUndefined();
    expect([...first.messages, ...second.messages].map((m) => m.id)).toEqual([
      ...new Set([...first.messages, ...second.messages].map((m) => m.id)),
    ]);
  });

  it("only ever calls the three read tools, and changes nothing in the mailbox", async () => {
    const { client, reader, context } = setup();
    client.receiveMail(USER, rawMail("a@example.com", "Code", new Date()));
    const before = JSON.stringify(client.mailboxFor(USER));
    await reader.mailbox(context);
    const all = { fromDomain: "example.com", after: new Date(0), limit: 5, maxBytes };
    await reader.recent(context, all);
    expect(CONNECTED_MAIL_READ_TOOLS).toEqual([
      "GMAIL_GET_PROFILE",
      "GMAIL_FETCH_EMAILS",
      "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
    ]);
    const tools = client.executions.map((execution) => execution.tool);
    expect(tools.length).toBeGreaterThan(2);
    for (const tool of tools) expect(CONNECTED_MAIL_READ_TOOLS).toContain(tool);
    for (const execution of client.executions)
      expect(execution.args).not.toHaveProperty("include_spam_trash");
    expect(JSON.stringify(client.mailboxFor(USER))).toBe(before);
  });

  it("asks for the domain's mail since the window's exact instant, by id, raw", async () => {
    const { client, reader, context } = setup();
    client.receiveMail(USER, rawMail("a@example.com", "Code", new Date()));
    await reader.recent(context, {
      fromDomain: "example.com",
      after: new Date("2026-03-05T23:30:00.900Z"),
      limit: 5,
      maxBytes: 4096,
    });
    const [tooLarge, list, read] = client.executions;
    // First whether any of it is larger than the read may hold, then the listing itself.
    expect(tooLarge?.args).toEqual({
      query: "from:example.com after:1772753400 larger:4096",
      max_results: 1,
      ids_only: true,
    });
    expect(list?.args).toEqual({
      query: "from:example.com after:1772753400",
      max_results: 5,
      ids_only: true,
    });
    expect(read?.args).toEqual({ message_id: expect.any(String), format: "raw" });
  });

  // BOUNDS: a message too large to read is never fetched. The provider is asked first whether
  // the search holds one, and what it returns is held to the limit before it is decoded. Either
  // way the read fails: the message may be the newest from the site.
  it.each<[name: string, sizes: number[], reads: number | "fails"]>([
    ["every message within the limit", [600, 600], 2],
    ["one message larger than the limit", [600, 5000], "fails"],
    ["messages that pass the limit together", [1800, 1800, 1800], "fails"],
  ])("with %s, reads the page: %s", async (_name, sizes, reads) => {
    const { client, reader, context } = setup();
    for (const [index, size] of sizes.entries()) {
      const text = "x".repeat(size - 200);
      client.receiveMail(USER, rawMail("a@example.com", `Code ${index}`, new Date(), text));
    }
    const query = { fromDomain: "example.com", after: new Date(0), limit: 5, maxBytes: 4096 };
    const read = reader.recent(context, query);
    if (reads === "fails") await expect(read).rejects.toThrow(/too large|larger than/);
    else expect((await read).messages).toHaveLength(reads);
    const fetched = client.executions.filter(
      (execution) => execution.tool === "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
    );
    // No message is fetched once the provider says one is too large.
    expect(fetched).toHaveLength(sizes.some((size) => size > 4096) ? 0 : Math.min(sizes.length, 3));
  });

  it("holds what the provider returns to the limit, whatever size it reported", async () => {
    // The provider said nothing was larger; the message it then returns is.
    const raw = Buffer.from(`From: a@example.com\r\n\r\n${"x".repeat(5000)}`).toString("base64");
    const stub: Pick<ConnectorProvider, "execute"> = {
      async *execute(call) {
        const listing = call.tool === "GMAIL_FETCH_EMAILS";
        const probe = listing && String((call.args as { query: string }).query).includes("larger:");
        const messages = probe ? [] : [{ messageId: "m1" }];
        yield {
          type: "result",
          data: { data: listing ? { messages } : { raw, internalDate: "1" } },
        };
      },
    };
    const connection = { id: "c", connectorId: "composio", externalId: "GMAIL", displayName: "" };
    const context = {
      operationId: "x",
      traceId: "x",
      spaceId: "s",
      userId: USER,
      signal: AbortSignal.timeout(1000),
    };
    const from = Buffer.from;
    const decoded = vi.spyOn(Buffer, "from");
    const read = composioMailSource(stub)
      .readerFor(connection)!
      .recent(context, { fromDomain: "example.com", after: new Date(0), limit: 5, maxBytes: 4096 });
    await expect(read).rejects.toThrow("larger than the read may hold");
    const decodings = (decoded.mock.calls as unknown[][]).filter(([, as]) => as === "base64");
    expect(decodings).toEqual([]);
    decoded.mockRestore();
    expect(Buffer.from).toBe(from);
  });

  it("finds mail from early in the UTC day in a mailbox whose clock is behind UTC", async () => {
    // A day-granular after: would be resolved on the mailbox's clock and start hours later.
    const { client, reader, context } = setup();
    const runStart = new Date("2026-03-05T02:00:00Z");
    client.receiveMail(
      USER,
      rawMail("a@example.com", "Code", new Date("2026-03-05T03:00:00Z")),
      new Date("2026-03-05T03:00:00Z"),
    );
    const { messages: found } = await reader.recent(context, {
      fromDomain: "example.com",
      after: runStart,
      limit: 5,
      maxBytes,
    });
    expect(found).toHaveLength(1);
  });

  it("gives every call its own execution, as the connector tells attempts apart", async () => {
    const { client, registry, reader, context } = setup();
    const execute = vi.spyOn(registry, "execute");
    client.receiveMail(USER, rawMail("a@example.com", "One", new Date()));
    client.receiveMail(USER, rawMail("a@example.com", "Two", new Date()));
    const all = { fromDomain: "example.com", after: new Date(0), limit: 5, maxBytes };
    await reader.recent(context, all);
    const ids = execute.mock.calls.map(([call]) => call.executionId);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("makes no more calls once the look gave up, though the provider answers", async () => {
    const { client, registry, reader, context } = setup();
    for (const subject of ["One", "Two", "Three"])
      client.receiveMail(USER, rawMail("a@example.com", subject, new Date()));
    const look = new AbortController();
    const execute = registry.execute.bind(registry);
    const tools: string[] = [];
    vi.spyOn(registry, "execute").mockImplementation((call, callContext) => {
      tools.push(call.tool);
      const events = execute(call, callContext);
      // The look times out while the first message is read; the provider still answers.
      if (call.tool === "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID") look.abort(new Error("timed out"));
      return events;
    });
    await expect(
      reader.recent(
        { ...context, signal: look.signal },
        { fromDomain: "example.com", after: new Date(0), limit: 5, maxBytes },
      ),
    ).rejects.toThrow("timed out");
    expect(tools).toEqual([
      "GMAIL_FETCH_EMAILS",
      "GMAIL_FETCH_EMAILS",
      "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
    ]);
  });

  // The rule: a listing that says there is no mail gives none; one in any other shape, or any
  // message in it that cannot be read, fails the read, so the card opens rather than another
  // message answering for what was not read.
  it.each<[state: string, data: unknown, outcome: "none" | "fails"]>([
    ["a listing without messages", {}, "none"],
    ["a listing with no messages", { messages: [] }, "none"],
    ["a listing in no shape at all", null, "fails"],
    ["a listing that is text", "text", "fails"],
    ["a listing that is a bare list", [{ messageId: "m1" }], "fails"],
    ["a listing whose messages are not a list", { messages: "none" }, "fails"],
    ["a listing with a message without an id", { messages: [{ id: 1 }] }, "fails"],
    [
      "a listed message that comes back without its raw form",
      { messages: [{ messageId: "m1" }] },
      "fails",
    ],
  ])("on %s, %s", async (_state, data, outcome) => {
    const stub: Pick<ConnectorProvider, "execute"> = {
      async *execute(call) {
        // The provider says no message is too large; the listing itself is what is tested.
        const args = call.args as { query?: string };
        yield { type: "result", data: { data: args.query?.includes("larger:") ? {} : data } };
      },
    };
    const connection = { id: "c", connectorId: "composio", externalId: "GMAIL", displayName: "" };
    const context = {
      operationId: "x",
      traceId: "x",
      spaceId: "s",
      userId: USER,
      signal: AbortSignal.timeout(1000),
    };
    const query = { fromDomain: "example.com", after: new Date(0), limit: 5, maxBytes };
    const read = composioMailSource(stub).readerFor(connection)!.recent(context, query);
    if (outcome === "none") await expect(read).resolves.toEqual({ messages: [] });
    else await expect(read).rejects.toThrow(/cannot be read|has no id/);
  });

  it("fails when it cannot learn whether a message is too large", async () => {
    const stub: Pick<ConnectorProvider, "execute"> = {
      async *execute(call) {
        const args = call.args as { query?: string };
        yield { type: "result", data: { data: args.query?.includes("larger:") ? "text" : {} } };
      },
    };
    const connection = { id: "c", connectorId: "composio", externalId: "GMAIL", displayName: "" };
    const context = {
      operationId: "x",
      traceId: "x",
      spaceId: "s",
      userId: USER,
      signal: AbortSignal.timeout(1000),
    };
    const query = { fromDomain: "example.com", after: new Date(0), limit: 5, maxBytes };
    await expect(
      composioMailSource(stub).readerFor(connection)!.recent(context, query),
    ).rejects.toThrow("cannot be read");
  });

  it("fails on a listing longer than asked for, rather than leave some unread", async () => {
    const ids = ["m1", "m2", "m3", "m4", "m5", "m6"];
    const mail = "From: a@example.com\r\n\r\nYour code is 482913\r\n";
    const raw = Buffer.from(mail).toString("base64");
    const stub: Pick<ConnectorProvider, "execute"> = {
      async *execute(call) {
        const args = call.args as { query?: string };
        const listed = args.query?.includes("larger:") ? [] : ids;
        yield {
          type: "result",
          data: {
            data:
              call.tool === "GMAIL_FETCH_EMAILS"
                ? { messages: listed.map((messageId) => ({ messageId })) }
                : { raw, internalDate: "1" },
          },
        };
      },
    };
    const connection = { id: "c", connectorId: "composio", externalId: "GMAIL", displayName: "" };
    const context = {
      operationId: "x",
      traceId: "x",
      spaceId: "s",
      userId: USER,
      signal: AbortSignal.timeout(1000),
    };
    const query = { fromDomain: "example.com", after: new Date(0), limit: 5, maxBytes };
    const read = composioMailSource(stub).readerFor(connection)!.recent(context, query);
    await expect(read).rejects.toThrow("more messages than");
  });

  it("fails when the mailbox's address cannot be read", async () => {
    const stub: Pick<ConnectorProvider, "execute"> = {
      async *execute() {
        yield { type: "result", data: { data: { profile: {} } } };
      },
    };
    const connection = { id: "c", connectorId: "composio", externalId: "GMAIL", displayName: "" };
    await expect(
      composioMailSource(stub)
        .readerFor(connection)!
        .mailbox({
          operationId: "x",
          traceId: "x",
          spaceId: "s",
          userId: USER,
          signal: AbortSignal.timeout(1000),
        }),
    ).rejects.toThrow();
  });

  it("fails when the provider does", async () => {
    const failing: Pick<ConnectorProvider, "execute"> = {
      async *execute() {
        yield { type: "error", message: "rate limited" };
      },
    };
    const connection = { id: "c", connectorId: "composio", externalId: "GMAIL", displayName: "" };
    const reader = composioMailSource(failing).readerFor(connection)!;
    const context = {
      operationId: "x",
      traceId: "x",
      spaceId: "s",
      userId: USER,
      signal: AbortSignal.timeout(1000),
    };
    await expect(reader.mailbox(context)).rejects.toThrow("rate limited");
  });
});
