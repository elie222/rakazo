import {
  toolRequiresApproval,
  toolResultTaintsRun,
  unattendedTriggerToolRequiresApproval,
} from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import { botEmailInstruction } from "./run-instructions.js";
import { selectBuiltinToolsForRun } from "./run-tool-selection.js";
import { emailTools } from "./run-tools-email.js";

type Row = {
  id: string;
  botId: string;
  fromAddress: string;
  fromName: string;
  verified: boolean;
  sent: boolean;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  attachments: unknown[];
  receivedAt: Date;
};

function row(overrides: Partial<Row>): Row {
  return {
    id: "email-1",
    botId: "bot-1",
    fromAddress: "noreply@shop.test",
    fromName: "Shop",
    verified: false,
    sent: false,
    to: ["scout@bots.test"],
    cc: [],
    subject: "Your code",
    text: "Your sign-in code is 123456.",
    attachments: [],
    receivedAt: new Date("2026-11-05T10:00:00.000Z"),
    ...overrides,
  };
}

function fakeRun(rows: Row[], options: { runUserId?: string; arriving?: Row } = {}) {
  const inbox = [...rows];
  let listed = 0;
  const copyEarlierFiles = vi.fn();
  const matches = (email: Row, where: Record<string, unknown>) => {
    const since = (where.receivedAt as { gt: Date } | undefined)?.gt;
    const query = (where.OR as Array<Record<string, { contains: string }>> | undefined)?.[0];
    const words = query ? Object.values(query)[0]?.contains.toLowerCase() : undefined;
    return (
      email.botId === where.botId &&
      (!since || email.receivedAt > since) &&
      (!words ||
        [email.fromAddress, email.fromName, email.subject, email.text].some((field) =>
          field.toLowerCase().includes(words),
        ))
    );
  };
  const ctx = {
    deps: {
      prisma: {
        botEmailMessage: {
          findFirst: async ({ where }: { where: { id: string; botId: string } }) =>
            inbox.find((email) => email.id === where.id && email.botId === where.botId) ?? null,
          findMany: async ({ where }: { where: Record<string, unknown> }) => {
            listed += 1;
            // Mail that arrives while the bot waits shows up on the second look.
            if (listed === 2 && options.arriving) inbox.push(options.arriving);
            return inbox
              .filter((email) => matches(email, where))
              .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
          },
          deleteMany: async ({
            where,
          }: {
            where: { id: { in: string[] }; botId: string; sent: boolean };
          }) => {
            const gone = inbox.filter(
              (email) =>
                where.id.in.includes(email.id) &&
                email.botId === where.botId &&
                email.sent === where.sent,
            );
            for (const email of gone) inbox.splice(inbox.indexOf(email), 1);
            return { count: gone.length };
          },
        },
      },
    },
    bot: { id: "bot-1", userId: "owner-1" },
    run: { userId: options.runUserId ?? "owner-1" },
    computer: { copyEarlierFiles },
    context: { signal: new AbortController().signal },
  };
  const invoke = (name: "read_email" | "delete_email", args: Record<string, unknown>) =>
    emailTools[name]!(
      ctx as never,
      {
        name,
        args,
        executionId: "call-1",
        finish: async (result: unknown) => result,
      } as never,
    ) as Promise<Record<string, unknown>>;
  const call = (args: Record<string, unknown>) => invoke("read_email", args);
  const remove = (args: Record<string, unknown>) => invoke("delete_email", args);
  return { call, remove, inbox, copyEarlierFiles };
}

describe("read_email", () => {
  it("lists the newest mail as untrusted data", async () => {
    const { call } = fakeRun([
      row({ id: "old", receivedAt: new Date("2026-11-01T00:00:00.000Z"), subject: "Old" }),
      row({ id: "new", text: `Code 999.\n\n${"x".repeat(500)}` }),
      row({ id: "elsewhere", botId: "bot-2" }),
    ]);

    const result = await call({});

    expect(result.untrusted).toBe(true);
    expect(result.now).toEqual(expect.any(String));
    expect(result.emails).toEqual([
      expect.objectContaining({ id: "new", from: "Shop <noreply@shop.test>", verified: false }),
      expect.objectContaining({ id: "old", subject: "Old" }),
    ]);
    const preview = (result.emails as Array<{ preview: string }>)[0]?.preview ?? "";
    expect(preview.startsWith("Code 999. xxx")).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(160);
  });

  it("finds mail by words in it and by when it arrived", async () => {
    const { call } = fakeRun([
      row({ id: "receipt", subject: "Receipt #42", receivedAt: new Date("2026-11-04") }),
      row({ id: "code", subject: "Your code", receivedAt: new Date("2026-11-05") }),
    ]);

    expect(((await call({ query: "receipt" })).emails as unknown[]).length).toBe(1);
    expect(
      ((await call({ since: "2026-11-04T12:00:00.000Z" })).emails as Array<{ id: string }>).map(
        (email) => email.id,
      ),
    ).toEqual(["code"]);
  });

  it("waits for a matching email to arrive", async () => {
    const { call } = fakeRun([], { arriving: row({ id: "late", receivedAt: new Date() }) });

    const result = await call({ query: "code", waitSeconds: 10 });

    expect(result.emails).toEqual([expect.objectContaining({ id: "late" })]);
  });

  it("waits a wait shorter than one poll", async () => {
    const { call } = fakeRun([], { arriving: row({ id: "late", receivedAt: new Date() }) });

    const result = await call({ waitSeconds: 1 });

    expect(result.emails).toEqual([expect.objectContaining({ id: "late" })]);
  });

  it("reads one email whole, a page at a time, and copies its files", async () => {
    const { call, copyEarlierFiles } = fakeRun([
      row({
        text: "a".repeat(10_000),
        attachments: [
          { artifactId: "art-1", name: "invoice.pdf", mimeType: "application/pdf", size: 3 },
          { name: "setup.exe" },
        ],
      }),
    ]);

    const first = (await call({ id: "email-1" })).email as Record<string, unknown>;
    const rest = (await call({ id: "email-1", textOffset: first.nextTextOffset })).email as Record<
      string,
      unknown
    >;

    expect(first).toMatchObject({
      from: "Shop <noreply@shop.test>",
      verified: false,
      nextTextOffset: 8_000,
      files: [
        { name: "invoice.pdf", path: "attachments/art-1.pdf" },
        { name: "setup.exe", unavailable: true },
      ],
    });
    expect(String(first.text)).toHaveLength(8_000);
    expect(String(rest.text)).toHaveLength(2_000);
    expect(rest.nextTextOffset).toBeUndefined();
    expect(copyEarlierFiles).toHaveBeenCalledWith([
      expect.objectContaining({ kind: "file", artifactId: "art-1", name: "invoice.pdf" }),
    ]);
  });

  it("reads only this bot's mail, and only in its owner's runs", async () => {
    const mine = fakeRun([row({ id: "theirs", botId: "bot-2" })]);
    const visitor = fakeRun([row({})], { runUserId: "visitor-1" });

    expect(await mine.call({ id: "theirs" })).toEqual({
      error: "No email with that id in your inbox.",
    });
    expect(await visitor.call({})).toEqual({ error: "Only the bot's owner can do that." });
  });

  it("is offered only where the inbox may be read, and needs no approval to read", () => {
    const names = (emailInbox: boolean) =>
      selectBuiltinToolsForRun({
        graphicalToolsAllowed: false,
        groupId: null,
        trigger: "webhook",
        semanticMemoryEnabled: false,
        messagingChannelRun: false,
        emailInbox,
      }).map((tool) => tool.name);

    expect(names(true)).toContain("read_email");
    expect(names(false)).not.toContain("read_email");
    expect(unattendedTriggerToolRequiresApproval("webhook", "read_email", false)).toBe(false);
    // What it returns is someone else's mail, so the run counts as having read outside content.
    expect(toolResultTaintsRun("read_email")).toBe(true);
  });
});

describe("delete_email", () => {
  it("deletes only mail this bot received", async () => {
    const { remove, inbox } = fakeRun([
      row({ id: "spam" }),
      row({ id: "kept" }),
      row({ id: "theirs", botId: "bot-2" }),
      row({ id: "outgoing", sent: true }),
    ]);

    expect(await remove({ ids: ["spam", "spam", "theirs", "outgoing", "missing"] })).toEqual({
      deleted: 1,
    });
    expect(inbox.map((email) => email.id)).toEqual(["kept", "theirs", "outgoing"]);
  });

  it("works only in its owner's runs, for a bounded list of ids", async () => {
    const visitor = fakeRun([row({})], { runUserId: "visitor-1" });
    const owner = fakeRun([row({})]);

    expect(await visitor.remove({ ids: ["email-1"] })).toEqual({
      error: "Only the bot's owner can do that.",
    });
    expect(visitor.inbox).toHaveLength(1);
    expect(await owner.remove({ ids: [] })).toHaveProperty("error");
    expect(
      await owner.remove({ ids: Array.from({ length: 51 }, (_, index) => `e${index}`) }),
    ).toHaveProperty("error");
  });

  it("is offered with the inbox and follows the owner's approval settings", () => {
    const names = (emailInbox: boolean) =>
      selectBuiltinToolsForRun({
        graphicalToolsAllowed: false,
        groupId: null,
        trigger: "user",
        semanticMemoryEnabled: false,
        messagingChannelRun: false,
        emailInbox,
      }).map((tool) => tool.name);

    expect(names(true)).toContain("delete_email");
    expect(names(false)).not.toContain("delete_email");
    expect(toolRequiresApproval("delete_email", false)).toBe(true);
    expect(unattendedTriggerToolRequiresApproval("webhook", "delete_email", false)).toBe(true);
    expect(toolResultTaintsRun("delete_email")).toBe(false);
  });
});

describe("botEmailInstruction", () => {
  it("names only the inbox tools the run has", () => {
    const both = botEmailInstruction("scout@bots.test", { read: true, delete: true });
    const readOnly = botEmailInstruction("scout@bots.test", { read: true, delete: false });

    expect(both).toContain("read_email");
    expect(both).toContain("delete_email");
    expect(readOnly).toContain("read_email");
    expect(readOnly).not.toContain("delete_email");
    expect(botEmailInstruction("scout@bots.test", { read: false, delete: false })).toBe(
      "Your email address is scout@bots.test.",
    );
  });
});
