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
/** A mail connection and a call's context, for a reader over a stubbed provider. */
const CONNECTION = {
  id: "c",
  connectorId: "composio",
  externalId: "GMAIL",
  displayName: "",
  providerRef: "ca_1",
};
const stubContext = () => ({
  operationId: "x",
  traceId: "x",
  spaceId: "s",
  userId: USER,
  signal: AbortSignal.timeout(1000),
});

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
  // Which connections get a reader: a mail connection of this connector that names the one
  // account to read. One that names none (older rows hold nothing, or the provider's own name)
  // could not be held to an account, and the provider would read whichever mailbox it picks.
  it.each<[connection: string, change: Record<string, unknown>, read: boolean]>([
    ["a mail connection that names its account", {}, true],
    ["a connection to another app", { externalId: "github" }, false],
    ["another connector's mail connection", { connectorId: "pipedream" }, false],
    ["a mail connection that names no account", { providerRef: undefined }, false],
    ["a mail connection whose account is blank", { providerRef: "  " }, false],
    ["a mail connection that names the provider, not an account", { providerRef: "gmail" }, false],
    ["a mail connection that names the provider in capitals", { providerRef: " GMAIL " }, false],
  ])("for %s, gives a reader: %s", (_connection, change, read) => {
    const { source } = setup();
    expect(source.readerFor({ ...CONNECTION, ...change }) !== undefined).toBe(read);
  });

  it("holds every call it makes to the account its connection names", async () => {
    const { client, reader, context } = setup();
    // The user has a newer account of the same provider, which was not connected here.
    const newer = client.connect(USER, "GMAIL");
    client.receiveMail(USER, rawMail("a@example.com", "Code", new Date()));
    await reader.mailbox(context);
    const query = { fromDomain: "example.com", after: new Date(Date.now() - 60_000), limit: 5 };
    const { messages } = await reader.recent(context, query);
    await reader.read(context, messages[0]!.id, maxBytes);
    expect(client.executions.length).toBeGreaterThanOrEqual(4);
    // Every session opened for the user is held to that one account.
    const sessions = client.created.filter(({ userId }) => userId === USER);
    expect(sessions.length).toBeGreaterThan(0);
    const account = context.connectedConnections![0]!.providerRef;
    for (const { config } of sessions) {
      expect(Object.values(config.connectedAccounts ?? {})).toEqual([[account]]);
      expect(JSON.stringify(config)).not.toContain(newer);
    }
  });

  it("names the mailbox it reads", async () => {
    const { reader, context } = setup();
    await expect(reader.mailbox(context)).resolves.toBe("me@example.test");
  });

  it("lists the site's newest mail in the window, and reads each as received", async () => {
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
    });

    // What the provider tells of each without its content: who sent it, how large, and when.
    expect(messages).toEqual([
      {
        id: expect.any(String),
        from: "no-reply@example.com",
        size: Buffer.byteLength(second),
        receivedAt: new Date(now - 30_000),
      },
      {
        id: expect.any(String),
        from: "no-reply@example.com",
        size: Buffer.byteLength(first),
        receivedAt: new Date(now - 60_000),
      },
    ]);
    expect(new Set(messages.map((message) => message.id)).size).toBe(2);
    const read = await Promise.all(
      messages.map((message) => reader.read(context, message.id, maxBytes)),
    );
    expect(read.map((raw) => new TextDecoder().decode(raw))).toEqual([second, first]);
  });

  it("lists at most the limit a page, and names the next page while there is more", async () => {
    const { client, reader, context } = setup();
    for (let i = 0; i < 7; i++)
      client.receiveMail(USER, rawMail("a@example.com", `Code ${i}`, new Date(Date.now() - i)));
    const query = { fromDomain: "example.com", after: new Date(Date.now() - 3_600_000), limit: 5 };
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
    const all = { fromDomain: "example.com", after: new Date(0), limit: 5 };
    for (const message of (await reader.recent(context, all)).messages)
      await reader.read(context, message.id, maxBytes);
    expect(CONNECTED_MAIL_READ_TOOLS).toEqual([
      "GMAIL_GET_PROFILE",
      "GMAIL_FETCH_EMAILS",
      "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
    ]);
    const tools = client.executions.map((execution) => execution.tool);
    expect(tools.length).toBeGreaterThan(3);
    for (const tool of tools) expect(CONNECTED_MAIL_READ_TOOLS).toContain(tool);
    for (const execution of client.executions)
      expect(execution.args).not.toHaveProperty("include_spam_trash");
    expect(JSON.stringify(client.mailboxFor(USER))).toBe(before);
  });

  it("asks for the domain's mail since the window's exact instant, by id", async () => {
    const { client, reader, context } = setup();
    client.receiveMail(USER, rawMail("a@example.com", "Code", new Date()));
    const { messages } = await reader.recent(context, {
      fromDomain: "example.com",
      after: new Date("2026-03-05T23:30:00.900Z"),
      limit: 5,
    });
    await reader.read(context, messages[0]!.id, maxBytes);
    const [list, told, read] = client.executions;
    expect(list?.args).toEqual({
      query: "from:example.com after:1772753400",
      max_results: 5,
      ids_only: true,
    });
    // First what the provider tells of a listed message, and its content only when it is read.
    expect(told?.args).toEqual({ message_id: messages[0]!.id, format: "metadata" });
    expect(read?.args).toEqual({ message_id: messages[0]!.id, format: "raw" });
  });

  it("fetches the content of no message to list it, however large or whoever sent it", async () => {
    // The provider matches senders loosely: a large message from another sender is listed
    // beside the site's own, and neither is fetched until one is read.
    const { client, reader, context } = setup();
    const large = "x".repeat(200_000);
    const elsewhere = "big@example.com.elsewhere.test";
    client.receiveMail(USER, rawMail("a@example.com", "Code", new Date(Date.now() - 2000)));
    client.receiveMail(USER, rawMail(elsewhere, "Big", new Date(Date.now() - 1000), large));
    const query = { fromDomain: "example.com", after: new Date(0), limit: 5 };
    const { messages } = await reader.recent(context, query);
    expect(messages.map(({ from, size }) => [from, (size ?? 0) > 200_000])).toEqual([
      [elsewhere, true],
      ["a@example.com", false],
    ]);
    const formats = client.executions.flatMap(({ args }) => (args.format ? [args.format] : []));
    expect(formats).toEqual(["metadata", "metadata"]);
    expect(JSON.stringify(client.executions.map((execution) => execution.result))).not.toContain(
      large.slice(0, 64),
    );
  });

  // What a listing tells of a message is whatever the provider's metadata holds, however it
  // wraps it; what it does not hold is left out, for the caller to treat as not known.
  const headers = (...from: string[]) => ({
    payload: {
      headers: [
        { name: "To", value: "me@example.test" },
        ...from.map((value) => ({ name: "From", value })),
      ],
    },
  });
  it.each<[shape: string, data: unknown, listing: Record<string, unknown>]>([
    ["nothing", {}, {}],
    ["a sender", { sender: "A@Example.com" }, { from: "a@example.com" }],
    ["a named sender", { sender: "Sign-in <a@example.com>" }, { from: "a@example.com" }],
    ["a From header", headers("Sign-in <a@example.com>"), { from: "a@example.com" }],
    [
      "a From header in any case",
      { payload: { headers: [{ name: "FROM", value: "a@b.test" }] } },
      { from: "a@b.test" },
    ],
    // Anything a mail parser could read as another sender is left out, never guessed at.
    ["a quoted name holding another address", { sender: '"a@example.com" <b@other.test>' }, {}],
    ["two From headers", headers("a@example.com", "b@other.test"), {}],
    ["two senders", { sender: "a@example.com, b@other.test" }, {}],
    ["two senders in brackets", headers("<a@example.com>, <b@other.test>"), {}],
    ["a sender with a comment", { sender: "a@example.com (b at other.test)" }, {}],
    ["a sender whose domain is no plain host name", { sender: "a@example.com." }, {}],
    ["a sender that is no address", { sender: "Sign-in team" }, {}],
    ["its headers, none of them From", { payload: { headers: [] }, sender: "a@example.com" }, {}],
    ["a size", { sizeEstimate: 2048 }, { size: 2048 }],
    ["a size as text", { sizeEstimate: "2048" }, { size: 2048 }],
    ["a size that is no number", { sizeEstimate: "large" }, {}],
    ["a time", { internalDate: "1772753400000" }, { receivedAt: new Date(1772753400000) }],
    ["a time that is no number", { internalDate: "yesterday" }, {}],
    [
      "all of it, wrapped once more",
      { message: { sender: "a@example.com", sizeEstimate: 9, internalDate: 5 } },
      { from: "a@example.com", size: 9, receivedAt: new Date(5) },
    ],
  ])("lists a message whose metadata holds %s", async (_shape, data, listing) => {
    const stub: Pick<ConnectorProvider, "execute"> = {
      async *execute(call) {
        const listed = call.tool === "GMAIL_FETCH_EMAILS";
        yield {
          type: "result",
          data: { data: listed ? { messages: [{ messageId: "m1" }] } : data },
        };
      },
    };
    const query = { fromDomain: "example.com", after: new Date(0), limit: 5 };
    const page = await composioMailSource(stub).readerFor(CONNECTION)!.recent(stubContext(), query);
    expect(page).toEqual({ messages: [{ id: "m1", ...listing }] });
  });

  // BOUNDS: a message is held to what its read may hold by its encoded length, before any of it
  // is decoded, whatever size its listing gave.
  it.each<[name: string, bytes: number, read: boolean]>([
    ["within what the read may hold", 4096, true],
    ["one byte past what the read may hold", 4097, false],
    ["far past what the read may hold", 400_000, false],
  ])("reads a message %s: %s", async (_name, bytes, read) => {
    const raw = Buffer.alloc(bytes, "x").toString("base64url");
    const stub: Pick<ConnectorProvider, "execute"> = {
      async *execute() {
        yield { type: "result", data: { data: { raw, internalDate: "1" } } };
      },
    };
    const from = Buffer.from;
    const decoded = vi.spyOn(Buffer, "from");
    const reading = composioMailSource(stub).readerFor(CONNECTION)!.read(stubContext(), "m1", 4096);
    if (read) expect((await reading).byteLength).toBe(bytes);
    else await expect(reading).rejects.toThrow("larger than the read may hold");
    const decodings = (decoded.mock.calls as unknown[][]).filter(([, as]) => as === "base64");
    expect(decodings).toHaveLength(read ? 1 : 0);
    decoded.mockRestore();
    expect(Buffer.from).toBe(from);
  });

  it("fails to read a message that comes back without its raw form", async () => {
    const stub: Pick<ConnectorProvider, "execute"> = {
      async *execute() {
        yield { type: "result", data: { data: { messageId: "m1", internalDate: "1" } } };
      },
    };
    await expect(
      composioMailSource(stub).readerFor(CONNECTION)!.read(stubContext(), "m1", maxBytes),
    ).rejects.toThrow("cannot be read in its raw form");
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
    });
    expect(found).toHaveLength(1);
  });

  it("gives every call its own execution, as the connector tells attempts apart", async () => {
    const { client, registry, reader, context } = setup();
    const execute = vi.spyOn(registry, "execute");
    client.receiveMail(USER, rawMail("a@example.com", "One", new Date()));
    client.receiveMail(USER, rawMail("a@example.com", "Two", new Date()));
    await reader.recent(context, { fromDomain: "example.com", after: new Date(0), limit: 5 });
    const ids = execute.mock.calls.map(([call]) => call.executionId);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("asks about a page's messages together, so other senders' mail costs one wait", async () => {
    const ids = ["m1", "m2", "m3", "m4", "m5"];
    let asked = 0;
    let answer = () => {};
    const all = new Promise<void>((resolve) => {
      answer = resolve;
    });
    // The provider answers about no message until it was asked about every one on the page.
    const stub: Pick<ConnectorProvider, "execute"> = {
      async *execute(call) {
        if (call.tool === "GMAIL_FETCH_EMAILS") {
          yield { type: "result", data: { data: { messages: ids.map((id) => ({ id })) } } };
          return;
        }
        if (++asked === ids.length) answer();
        await all;
        yield { type: "result", data: { data: { sender: "a@other.test", internalDate: "1" } } };
      },
    };
    const query = { fromDomain: "example.com", after: new Date(0), limit: 5 };
    const page = await composioMailSource(stub).readerFor(CONNECTION)!.recent(stubContext(), query);
    expect(page.messages.map(({ id }) => id)).toEqual(ids);
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
      // The look times out while the first message is asked about; the provider still answers.
      if (call.tool === "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID") look.abort(new Error("timed out"));
      return events;
    });
    await expect(
      reader.recent(
        { ...context, signal: look.signal },
        { fromDomain: "example.com", after: new Date(0), limit: 5 },
      ),
    ).rejects.toThrow("timed out");
    expect(tools).toEqual(["GMAIL_FETCH_EMAILS", "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID"]);
  });

  // The rule: a listing that says there is no mail gives none; one in any other shape fails,
  // so the card opens rather than another message answering for what was not listed.
  it.each<[state: string, data: unknown, outcome: "none" | "fails"]>([
    ["a listing without messages", {}, "none"],
    ["a listing with no messages", { messages: [] }, "none"],
    ["a listing in no shape at all", null, "fails"],
    ["a listing that is text", "text", "fails"],
    ["a listing that is a bare list", [{ messageId: "m1" }], "fails"],
    ["a listing whose messages are not a list", { messages: "none" }, "fails"],
    ["a listing with a message without an id", { messages: [{ id: 1 }] }, "fails"],
  ])("on %s, %s", async (_state, data, outcome) => {
    const stub: Pick<ConnectorProvider, "execute"> = {
      async *execute() {
        yield { type: "result", data: { data } };
      },
    };
    const query = { fromDomain: "example.com", after: new Date(0), limit: 5 };
    const read = composioMailSource(stub).readerFor(CONNECTION)!.recent(stubContext(), query);
    if (outcome === "none") await expect(read).resolves.toEqual({ messages: [] });
    else await expect(read).rejects.toThrow(/cannot be read|has no id/);
  });

  it("fails on a listing longer than asked for, rather than leave some unlisted", async () => {
    const ids = ["m1", "m2", "m3", "m4", "m5", "m6"];
    const stub: Pick<ConnectorProvider, "execute"> = {
      async *execute(call) {
        const listed = call.tool === "GMAIL_FETCH_EMAILS";
        const messages = ids.map((messageId) => ({ messageId }));
        yield { type: "result", data: { data: listed ? { messages } : { internalDate: "1" } } };
      },
    };
    const query = { fromDomain: "example.com", after: new Date(0), limit: 5 };
    const read = composioMailSource(stub).readerFor(CONNECTION)!.recent(stubContext(), query);
    await expect(read).rejects.toThrow("more messages than");
  });

  it("fails when the mailbox's address cannot be read", async () => {
    const stub: Pick<ConnectorProvider, "execute"> = {
      async *execute() {
        yield { type: "result", data: { data: { profile: {} } } };
      },
    };
    await expect(
      composioMailSource(stub)
        .readerFor(CONNECTION)!
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
    const reader = composioMailSource(failing).readerFor(CONNECTION)!;
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
