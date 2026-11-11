import type { AdapterContext, ConnectorProvider } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { ComposioConnector } from "./composio-connector.js";
import { FakeComposioClient } from "./composio-fake.js";
import { CONNECTED_MAIL_READ_TOOLS, composioMailSource } from "./composio-mail.js";
import { connectedContext } from "./connection-context.js";
import { ConnectorRegistry } from "./connector-registry.js";

const USER = "user-1";

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

  it("reads no more than the limit a page, and names the next page while the window holds more", async () => {
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
    await reader.recent(context, { fromDomain: "example.com", after: new Date(0), limit: 5 });
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

  it("asks for mail from the domain since the exact instant of the window, by id, in raw form", async () => {
    const { client, reader, context } = setup();
    client.receiveMail(USER, rawMail("a@example.com", "Code", new Date()));
    await reader.recent(context, {
      fromDomain: "example.com",
      after: new Date("2026-03-05T23:30:00.900Z"),
      limit: 5,
    });
    const [list, read] = client.executions;
    expect(list?.args).toEqual({
      query: "from:example.com after:1772753400",
      max_results: 5,
      ids_only: true,
    });
    expect(read?.args).toEqual({ message_id: expect.any(String), format: "raw" });
  });

  it("finds mail that came early in the UTC day in a mailbox whose clock is behind UTC", async () => {
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

  it("gives every call its own execution, as the connector tells attempts apart by it", async () => {
    const { client, registry, reader, context } = setup();
    const execute = vi.spyOn(registry, "execute");
    client.receiveMail(USER, rawMail("a@example.com", "One", new Date()));
    client.receiveMail(USER, rawMail("a@example.com", "Two", new Date()));
    await reader.recent(context, { fromDomain: "example.com", after: new Date(0), limit: 5 });
    const ids = execute.mock.calls.map(([call]) => call.executionId);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(ids.length);
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
      async *execute() {
        yield { type: "result", data: { data } };
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
    const query = { fromDomain: "example.com", after: new Date(0), limit: 5 };
    const read = composioMailSource(stub).readerFor(connection)!.recent(context, query);
    if (outcome === "none") await expect(read).resolves.toEqual({ messages: [] });
    else await expect(read).rejects.toThrow(/cannot be read|has no id/);
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
