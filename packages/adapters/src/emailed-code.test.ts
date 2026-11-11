import { createHash, generateKeyPairSync } from "node:crypto";
import { promises as dnsPromises } from "node:dns";
import type {
  ConnectedConnector,
  ConnectedMailMessage,
  ConnectedMailPage,
  ConnectedMailReader,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { installAuditEventStore } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { dkimSign } from "mailauth";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  answerCodeCardsFromInbox,
  CONNECTED_MAIL_LIMIT,
  CONNECTED_MAIL_PAGE_LIMIT,
  EMAIL_READ_LIMIT,
  EMAIL_SEARCH_LIMIT,
  EMAILED_CODE_WINDOW_MS,
  emailMayAnswer,
  takeEmailedCode,
} from "./emailed-code.js";

const ORIGIN = "https://login.example.test";
const CODE = "482913";
/** The claim on the test email's message, which a copy delivered again shares. */
const EMAIL_CLAIM = `emailed-code:email:bot-1:${createHash("sha256").update("dkim:signature-1").digest("base64url")}`;
const bot = { id: "bot-1", userId: "user-1" };
const ago = (ms: number) => new Date(Date.now() - ms);

type Row = Record<string, unknown>;

/** A bot whose owner's run waits on a code card, and the mail that just came in. */
function inbox(
  options: {
    runs?: Row[];
    cards?: Record<string, Row>;
    emails?: Row[];
    /** When another secret request of the bot's was answered. */
    answeredAt?: Date;
    /** The run that request was in: the bot's own run unless given. */
    answeredIn?: { botId: string; userId: string };
    /** The connected mailbox's own address. */
    mailbox?: string;
    answered?: boolean | Error;
    /** The origin each run's browser was on when it asked; absent means it was not seen. */
    pages?: Record<string, string | null>;
    /** Effects already recorded, by idempotency key. */
    effects?: Record<string, Row>;
    /** The owner's connections in the Space, and what each one's mailbox holds. */
    connections?: Row[];
    connected?: Partial<ConnectedMailReader> | Error;
    /** Whether the bot may read the owner's connected mail for codes. */
    connectedMailCodes?: boolean;
    /** The owner turned that off after the attempt started. */
    switchedOff?: boolean;
  } = {},
) {
  const runs = options.runs ?? [waitingRun()];
  const cards = options.cards ?? { "run-1": codeCard() };
  const emails = options.emails ?? [codeEmail()];
  const effects = new Map<string, Row>(Object.entries(options.effects ?? {}));
  for (const run of runs) {
    const id = String(run.id);
    const page = options.pages
      ? options.pages[id]
      : ((cards[id]?.oneTimeCode as Row)?.origin ?? null);
    if (page)
      effects.set(`emailed-code:page:request-${id}`, { runId: id, request: { origin: page } });
  }
  const answeredIn: Row = options.answeredIn ?? { botId: bot.id, userId: bot.userId };
  const answeredRunMatches = ({ run }: { run?: Row }): boolean =>
    !run ||
    (Array.isArray(run.OR)
      ? (run.OR as Row[]).some((one) => answeredRunMatches({ run: one }))
      : Object.entries(run).every(([field, value]) => answeredIn[field] === value));
  const answerRunInput = vi.fn(
    async ({ claimEmail }: { claimEmail?: (tx: unknown) => Promise<void> }) => {
      if (options.answered === false) return false;
      // The email is taken in the answer's own transaction, as the database does it.
      return (prisma.$transaction as (fn: (tx: unknown) => Promise<boolean>) => Promise<boolean>)(
        async (tx) => {
          await claimEmail?.(tx);
          if (options.answered instanceof Error) throw options.answered;
          return true;
        },
      );
    },
  );
  const enqueue = vi.fn(async (_job: unknown) => undefined);
  const prisma: Record<string, unknown> = {
    run: {
      findMany: vi.fn(async ({ where }: { where: Row }) =>
        runs.filter(
          (run) =>
            (!where.id || run.id === where.id) && (!where.status || run.status === where.status),
        ),
      ),
    },
    message: {
      findMany: async ({ where }: { where: { runId: string } }) =>
        cards[where.runId] ? [{ id: `card-${where.runId}`, blocks: [cards[where.runId]] }] : [],
    },
    externalEffect: {
      findFirst: vi.fn(async ({ where }: { where: { runId?: string; status: unknown } }) =>
        where.status === "intended"
          ? cards[where.runId!]
            ? { id: `request-${where.runId}`, createdAt: ago(60 * 1000) }
            : null
          : options.answeredAt && answeredRunMatches(where as { run?: Row })
            ? { updatedAt: options.answeredAt }
            : null,
      ),
      findUnique: async ({ where }: { where: { idempotencyKey: string } }) =>
        effects.get(where.idempotencyKey) ?? null,
      findMany: async ({ where }: { where: { idempotencyKey: { in: string[] } } }) =>
        where.idempotencyKey.in
          .filter((key) => effects.has(key))
          .map((idempotencyKey) => ({ idempotencyKey })),
      createMany: async ({ data }: { data: Row[] }) => {
        let count = 0;
        for (const row of data) {
          const key = String(row.idempotencyKey);
          if (effects.has(key)) continue;
          effects.set(key, row);
          count += 1;
        }
        return { count };
      },
    },
    // All or nothing, as PostgreSQL would.
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const before = new Map(effects);
      try {
        return await fn(prisma);
      } catch (error) {
        effects.clear();
        for (const [key, row] of before) effects.set(key, row);
        throw error;
      }
    },
    botEmailMessage: {
      // Newest first, paged by cursor and take, as the database does it.
      findMany: async ({
        where,
        cursor,
        skip,
        take,
      }: {
        where: { id?: { in: string[] }; receivedAt: { gte: Date; gt?: Date } };
        cursor?: { id: string };
        skip?: number;
        take?: number;
      }) => {
        if (where.id) return emails.filter((email) => where.id?.in.includes(String(email.id)));
        const inWindow = emails
          .filter(
            (email) =>
              (email.receivedAt as Date) >= where.receivedAt.gte &&
              (!where.receivedAt.gt || (email.receivedAt as Date) > where.receivedAt.gt),
          )
          .sort((a, b) => (b.receivedAt as Date).getTime() - (a.receivedAt as Date).getTime());
        const start = cursor ? inWindow.findIndex((email) => email.id === cursor.id) : 0;
        if (start < 0) return [];
        return inWindow.slice(start + (skip ?? 0), start + (skip ?? 0) + (take ?? inWindow.length));
      },
    },
    externalConversation: { findUnique: async () => null },
    bot: {
      findUnique: async () => ({
        connectedMailCodes: Boolean(options.connectedMailCodes) && !options.switchedOff,
      }),
    },
    connection: {
      findMany: vi.fn(async () => options.connections ?? [mailConnection()]),
    },
  };
  const mailbox = vi.fn(async () => options.mailbox ?? "owner@example.net");
  const recent = vi.fn(async (): Promise<ConnectedMailPage> => ({ messages: [] }));
  const reader: ConnectedMailReader = {
    mailbox,
    recent,
    ...(options.connected instanceof Error ? {} : options.connected),
  };
  const readerFor = vi.fn((connection: ConnectedConnector) =>
    options.connected instanceof Error
      ? { mailbox, recent: async () => Promise.reject(options.connected) }
      : connection.connectorId === "composio" && connection.externalId === "GMAIL"
        ? reader
        : undefined,
  );
  const deliver = (runId?: string) =>
    answerCodeCardsFromInbox(
      {
        prisma: prisma as unknown as PrismaClient,
        events: { answerRunInput } as never,
        jobs: { enqueue },
        botEmailDomain: "bots.test",
        connectedMail: options.connectedMailCodes ? { readerFor } : undefined,
      },
      bot,
      runId,
    );
  return {
    deliver,
    answerRunInput,
    enqueue,
    prisma: prisma as typeof prisma & {
      run: { findMany: ReturnType<typeof vi.fn> };
      connection: { findMany: ReturnType<typeof vi.fn> };
    },
    effects,
    readerFor,
    recent,
  };
}

function mailConnection(overrides: Row = {}): Row {
  return {
    id: "connection-1",
    connectorId: "composio",
    provider: "GMAIL",
    providerRef: "ca_1",
    displayName: "Mail",
    status: "connected",
    ...overrides,
  };
}

const dkim = (() => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    record: `v=DKIM1; k=rsa; p=${publicKey.export({ type: "spki", format: "der" }).toString("base64")}`,
  };
})();

/** A message in a connected mailbox, signed by the sender's domain unless `signed` is false. */
async function connectedMail(
  options: {
    id?: string;
    from?: string;
    to?: string;
    code?: string;
    signed?: boolean;
    headers?: string[];
    /** When the mailbox received it, a few seconds ago unless given; null when not told. */
    receivedAt?: Date | null;
    /** The site's key the signature names: `s2`'s lookup fails for now. */
    selector?: string;
  } = {},
): Promise<ConnectedMailMessage> {
  const from = options.from ?? "no-reply@example.test";
  const domain = from.slice(from.indexOf("@") + 1);
  const raw = [
    `From: Example <${from}>`,
    `To: ${options.to ?? "owner@example.net"}`,
    "Subject: Your sign-in code",
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${options.id ?? "m1"}@${domain}>`,
    ...(options.headers ?? []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    `Your verification code is ${options.code ?? CODE}.`,
    "",
  ].join("\r\n");
  const signed =
    options.signed === false
      ? raw
      : (
          await dkimSign(raw, {
            signatureData: [
              {
                signingDomain: domain,
                selector: options.selector ?? "s1",
                privateKey: dkim.privateKey,
              },
            ],
          })
        ).signatures + raw;
  const receivedAt = options.receivedAt === undefined ? ago(10 * 1000) : options.receivedAt;
  return {
    id: options.id ?? "m1",
    raw: new TextEncoder().encode(signed),
    ...(receivedAt ? { receivedAt } : {}),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** The site's signing key, as its DNS publishes it. */
function publishKeys() {
  vi.spyOn(dnsPromises, "resolve").mockImplementation((async (name: string, type: string) => {
    if (type === "TXT" && name.startsWith("s1._domainkey.")) return [[dkim.record]];
    if (name.startsWith("s2._domainkey."))
      throw Object.assign(new Error(`queryTxt ETIMEOUT ${name}`), { code: "ETIMEOUT" });
    throw Object.assign(new Error(`queryTxt ENOTFOUND ${name}`), { code: "ENOTFOUND" });
  }) as never);
}

function waitingRun(overrides: Row = {}): Row {
  return {
    id: "run-1",
    status: "waiting_input",
    spaceId: "space-1",
    threadId: "thread-1",
    userId: "user-1",
    trigger: "user_message",
    createdAt: ago(10 * 60 * 1000),
    sourceMessage: { blocks: [], clientNonce: null },
    thread: { groupId: null, externalConversationId: null },
    ...overrides,
  };
}

function codeCard(origin = ORIGIN): Row {
  return {
    kind: "ask",
    text: "Code for login.example.test",
    input: "secret",
    oneTimeCode: { origin },
    purpose: "otp",
    status: "pending",
  };
}

function codeEmail(overrides: Row = {}): Row {
  return {
    id: "email-1",
    key: "dkim:signature-1",
    fromAddress: "no-reply@example.test",
    verified: true,
    mailingList: false,
    subject: "Your sign-in code",
    text: `Your verification code is ${CODE}.`,
    receivedAt: new Date(),
    ...overrides,
  };
}

describe("a code emailed to the bot while its run waits on the card", () => {
  it("answers the card as the run's user would, then wakes the run", async () => {
    const { deliver, answerRunInput, enqueue } = inbox();
    await deliver();
    expect(answerRunInput).toHaveBeenCalledExactlyOnceWith({
      spaceId: "space-1",
      threadId: "thread-1",
      runId: "run-1",
      messageId: "card-run-1",
      answeredByUserId: "user-1",
      answer: CODE,
      fromEmail: "email-1",
      claimEmail: expect.any(Function),
    });
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ payload: expect.objectContaining({ runId: "run-1" }) }),
    );
  });

  it("does nothing more when the owner answered first", async () => {
    const { deliver, enqueue } = inbox({ answered: false });
    await expect(deliver()).resolves.toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does not fail the email when the card changed under the answer", async () => {
    const { deliver, enqueue } = inbox({ answered: new Error("Secret request changed; retry") });
    await expect(deliver()).resolves.toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("leaves the card for the owner when the email is for another site", async () => {
    const { deliver, answerRunInput } = inbox({
      cards: { "run-1": codeCard("https://bank.test") },
    });
    await deliver();
    expect(answerRunInput).not.toHaveBeenCalled();
  });

  it("leaves a card for a plain HTTP page alone", async () => {
    const { deliver, answerRunInput } = inbox({
      cards: { "run-1": codeCard("http://login.example.test") },
    });
    await deliver();
    expect(answerRunInput).not.toHaveBeenCalled();
  });

  it("leaves a card that is not for a code alone", async () => {
    const card = { kind: "ask", text: "API key", input: "secret", status: "pending" };
    const { deliver, answerRunInput } = inbox({ cards: { "run-1": card } });
    await deliver();
    expect(answerRunInput).not.toHaveBeenCalled();
  });

  it("does nothing when no run is waiting", async () => {
    const { deliver, answerRunInput } = inbox({ runs: [] });
    await deliver();
    expect(answerRunInput).not.toHaveBeenCalled();
  });

  it("answers neither card when one email would answer two", async () => {
    const { deliver, answerRunInput } = inbox({
      runs: [waitingRun(), waitingRun({ id: "run-2", threadId: "thread-2" })],
      cards: { "run-1": codeCard(), "run-2": codeCard() },
    });
    await deliver();
    expect(answerRunInput).not.toHaveBeenCalled();
  });

  it.each<[string, Row[]]>([
    [
      "two other runs' waiting cards",
      [waitingRun(), waitingRun({ id: "run-2", threadId: "thread-2" })],
    ],
    ["another run's waiting card", [waitingRun()]],
  ])(
    "gives a run asking for a code none from an email that would answer %s",
    async (_name, runs) => {
      const { deliver, answerRunInput, prisma } = inbox({
        runs,
        cards: Object.fromEntries(runs.map((run) => [String(run.id), codeCard()])),
      });
      if (runs.length > 1) expect(await deliver()).toBe(0);
      const keep = vi.fn(async () => "kept");
      const taken = await takeEmailedCode(
        prisma as unknown as PrismaClient,
        {
          botId: bot.id,
          spaceId: "space-1",
          runId: "run-3",
          userId: bot.userId,
          origin: ORIGIN,
          after: ago(60 * 1000),
          botEmailDomain: "bots.test",
          sources: { inbox: true, connected: undefined },
        },
        keep,
      );
      expect(taken).toBeUndefined();
      expect(keep).not.toHaveBeenCalled();
      expect(answerRunInput).not.toHaveBeenCalled();
    },
  );

  it("answers neither card when one email would answer two, also when one run looks again", async () => {
    const { deliver, answerRunInput } = inbox({
      runs: [waitingRun(), waitingRun({ id: "run-2", threadId: "thread-2" })],
      cards: { "run-1": codeCard(), "run-2": codeCard() },
    });
    await deliver("run-2");
    expect(answerRunInput).not.toHaveBeenCalled();
  });

  it("ignores mail from long before the card was asked for", async () => {
    const { deliver, answerRunInput } = inbox({
      emails: [codeEmail({ receivedAt: ago(60 * 1000 + EMAILED_CODE_WINDOW_MS + 1000) })],
    });
    await deliver();
    expect(answerRunInput).not.toHaveBeenCalled();
  });

  it("never answers with an email that came before another request was answered", async () => {
    const { deliver, answerRunInput } = inbox({
      emails: [codeEmail({ receivedAt: ago(30 * 1000) })],
      answeredAt: ago(10 * 1000),
    });
    await deliver();
    expect(answerRunInput).not.toHaveBeenCalled();
  });

  it("takes a newer email than the last answered request", async () => {
    const { deliver, answerRunInput } = inbox({
      emails: [codeEmail({ receivedAt: ago(5 * 1000) })],
      answeredAt: ago(10 * 1000),
    });
    await deliver();
    expect(answerRunInput).toHaveBeenCalledOnce();
  });

  it("answers with an email once, claimed for the run it answered", async () => {
    const { deliver, answerRunInput, effects } = inbox();
    await expect(deliver()).resolves.toBe(1);
    expect(effects.get(EMAIL_CLAIM)).toMatchObject({ runId: "run-1", kind: "emailed_code" });
    await expect(deliver()).resolves.toBe(0);
    expect(answerRunInput).toHaveBeenCalledOnce();
  });

  it("never answers with an email another run claimed", async () => {
    const { deliver, answerRunInput } = inbox({
      effects: { [EMAIL_CLAIM]: { runId: "run-9" } },
    });
    await deliver();
    expect(answerRunInput).not.toHaveBeenCalled();
  });

  it("answers once with an email that was deleted and delivered again", async () => {
    const emails = [codeEmail()];
    const later = waitingRun({ id: "run-2", threadId: "thread-2", status: "running" });
    const { deliver, answerRunInput } = inbox({
      runs: [waitingRun(), later],
      emails,
      cards: { "run-1": codeCard(), "run-2": codeCard() },
    });
    await expect(deliver()).resolves.toBe(1);
    // The bot deleted the email; the sender's relay delivers the same signed message again, and
    // a later run asks for a code from the same site.
    emails.splice(0, 1, codeEmail({ id: "email-2", receivedAt: new Date() }));
    later.status = "waiting_input";
    await expect(deliver()).resolves.toBe(0);
    expect(answerRunInput).toHaveBeenCalledOnce();
  });

  it("finds the site's email under sixty newer signed emails from other senders", async () => {
    const emails = [
      codeEmail({ receivedAt: ago(60 * 1000) }),
      ...Array.from({ length: 60 }, (_, index) =>
        codeEmail({
          id: `other-${index}`,
          key: `dkim:other-${index}`,
          fromAddress: `news-${index}@elsewhere.test`,
          text: `Newsletter ${index}: your code is ${100_000 + index}.`,
          receivedAt: ago(1000 * (59 - index)),
        }),
      ),
    ];
    const { deliver, answerRunInput } = inbox({ emails });
    await expect(deliver()).resolves.toBe(1);
    expect(answerRunInput).toHaveBeenCalledOnce();
  });

  // The rule, for both sources: the search limit counts the site's mail only. Mail from other
  // senders, however much and however newer, is read past and never hides the site's email; the
  // provider's loose match (an address merely holding the site's domain) is other senders' mail.
  const others = (count: number, from: (index: number) => string) =>
    Array.from({ length: count }, (_, index) => ({
      id: `other-${index}`,
      from: from(index),
      receivedAt: ago(50_000 - index),
    }));
  it("reads no more of the bot's inbox than its read limit, and leaves the card past it", async () => {
    const other = others(EMAIL_READ_LIMIT, (index) => `news-${index}@elsewhere.test`);
    const { deliver, answerRunInput, prisma } = inbox({
      emails: [
        codeEmail({ receivedAt: ago(60 * 1000) }),
        ...other.map((mail) =>
          codeEmail({
            id: mail.id,
            key: `dkim:${mail.id}`,
            fromAddress: mail.from,
            receivedAt: mail.receivedAt,
          }),
        ),
      ],
    });
    const findMany = vi.spyOn(prisma.botEmailMessage as { findMany: () => unknown }, "findMany");
    await expect(deliver()).resolves.toBe(0);
    expect(answerRunInput).not.toHaveBeenCalled();
    const read = (await Promise.all(findMany.mock.results.map((result) => result.value))).flat();
    expect(read.length).toBeLessThanOrEqual(EMAIL_READ_LIMIT);
  });

  it.each<[source: string, newerFromOthers: number]>([
    ["the bot's inbox", EMAIL_SEARCH_LIMIT + 20],
    ["a connected mailbox", CONNECTED_MAIL_LIMIT * 3 + 1],
  ])(
    "finds the site's email in %s under more newer mail from other senders than the search limit",
    async (source, newerFromOthers) => {
      const inInbox = source === "the bot's inbox";
      const other = others(newerFromOthers, (index) =>
        inInbox ? `news-${index}@elsewhere.test` : `news-${index}@example.test.elsewhere.test`,
      );
      if (inInbox) {
        const { deliver, answerRunInput } = inbox({
          emails: [
            codeEmail({ receivedAt: ago(60 * 1000) }),
            ...other.map((mail) =>
              codeEmail({
                id: mail.id,
                key: `dkim:${mail.id}`,
                fromAddress: mail.from,
                text: `Newsletter: your code is ${mail.id.slice(-1)}00123.`,
                receivedAt: mail.receivedAt,
              }),
            ),
          ],
        });
        await expect(deliver()).resolves.toBe(1);
        expect(answerRunInput).toHaveBeenCalledOnce();
        return;
      }
      publishKeys();
      // The provider matched them all to the site's domain, and pages them newest first; the
      // site's own email is on the last page.
      const all = [
        ...(await Promise.all(
          other.map((mail, index) => connectedMail({ ...mail, code: String(100_000 + index) })),
        )),
        await connectedMail({ id: "code", receivedAt: ago(60 * 1000) }),
      ];
      const recent = vi.fn(async (_context: unknown, query: { limit: number; page?: string }) => {
        const start = Number(query.page ?? 0);
        const end = start + query.limit;
        return {
          messages: all.slice(start, end),
          ...(end < all.length ? { next: String(end) } : {}),
        };
      });
      const { deliver, answerRunInput } = inbox({
        emails: [],
        connectedMailCodes: true,
        connected: { recent },
      });
      expect(await deliver("run-1")).toBe(1);
      expect(answerRunInput).toHaveBeenCalledOnce();
      expect(recent.mock.calls.map(([, query]) => query.page)).toEqual(
        Array.from({ length: Math.ceil(all.length / CONNECTED_MAIL_LIMIT) }, (_, index) =>
          index ? String(index * CONNECTED_MAIL_LIMIT) : undefined,
        ),
      );
    },
  );

  // The rule, for both sources: the code is the one the site's mail in the window gives when all
  // of it is read, newest first, past other senders' mail. A read cut short by a limit gives none
  // (the card opens), so neither an older message nor the next source answers for unread mail.
  const FALLBACK = "650372";
  it.each<
    [name: string, inInbox: boolean, site: (string | null)[], others: number, answer?: string]
  >([
    ["one email under a page of newer mail from others", true, [CODE], 60, CODE],
    ["two emails with the same code", true, [CODE, CODE], 0, CODE],
    ["two emails with different codes", true, ["731905", CODE], 0],
    [
      "more of the site's emails than it compares, the oldest with another code",
      true,
      [...Array(EMAIL_SEARCH_LIMIT).fill(CODE), "731905"],
      0,
    ],
    [
      "more of the site's emails than it compares, only the oldest with a code",
      true,
      [...Array(EMAIL_SEARCH_LIMIT).fill(null), CODE],
      0,
    ],
    [
      "one message under pages of newer mail from others",
      false,
      [CODE],
      CONNECTED_MAIL_LIMIT * 3 + 1,
      CODE,
    ],
    ["two messages with the same code", false, [CODE, CODE], 0, CODE],
    ["two messages with different codes", false, ["731905", CODE], 0],
    [
      "more of the site's messages than it reads, the oldest with another code",
      false,
      [...Array(CONNECTED_MAIL_LIMIT).fill(CODE), "731905"],
      0,
    ],
    [
      "more of the site's messages than it reads, only the oldest with a code",
      false,
      [...Array(CONNECTED_MAIL_LIMIT).fill(null), CODE],
      0,
    ],
  ])("with %s, answers with the code it should", async (_name, inInbox, site, others, answer) => {
    publishKeys();
    const sent = (index: number, from: string, code: string | null) => ({
      id: `${from.split("@")[0]}-${index}`,
      from,
      code: code ?? "on its way",
      // Other senders' mail is the newest, then the site's, newest first.
      receivedAt: ago(from.endsWith("@example.test") ? 20_000 + index : 10_000 - index),
    });
    const mail = [
      ...Array.from({ length: others }, (_, index) =>
        sent(index, `news-${index}@example.test.elsewhere.test`, String(100_000 + index)),
      ),
      ...site.map((code, index) => sent(index, "no-reply@example.test", code)),
    ];
    // The inbox's rows give way to a connected mailbox holding another code, which may answer only
    // when the inbox has none of the site's mail.
    const fallback = [await connectedMail({ id: "fallback", code: FALLBACK })];
    const all = inInbox ? fallback : await Promise.all(mail.map((one) => connectedMail(one)));
    const recent = vi.fn(async (_context: unknown, query: { limit: number; page?: string }) => {
      const start = Number(query.page ?? 0);
      const end = start + query.limit;
      return {
        messages: all.slice(start, end),
        ...(end < all.length ? { next: String(end) } : {}),
      };
    });
    const { deliver, answerRunInput } = inbox({
      emails: inInbox
        ? mail.map((one) =>
            codeEmail({
              id: one.id,
              key: `dkim:${one.id}`,
              fromAddress: one.from,
              text: `Your verification code is ${one.code}.`,
              receivedAt: one.receivedAt,
            }),
          )
        : [],
      connectedMailCodes: true,
      connected: { recent },
    });
    await deliver("run-1");
    if (answer)
      expect(answerRunInput).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ answer }));
    else expect(answerRunInput).not.toHaveBeenCalled();
  });

  it("reads the subject and text only of the site's mail no run took a code from", async () => {
    const { deliver, answerRunInput, prisma } = inbox({
      emails: [
        codeEmail({ id: "news", key: "dkim:news", fromAddress: "news@elsewhere.test" }),
        codeEmail({ id: "taken", key: "dkim:taken", receivedAt: ago(5_000) }),
        codeEmail({ receivedAt: ago(10_000) }),
      ],
      effects: {
        [`emailed-code:email:bot-1:${createHash("sha256").update("dkim:taken").digest("base64url")}`]:
          { runId: "run-9" },
      },
    });
    const findMany = vi.spyOn(prisma.botEmailMessage as { findMany: () => unknown }, "findMany");
    await expect(deliver()).resolves.toBe(1);
    expect(answerRunInput).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ fromEmail: "email-1" }),
    );
    const bodiesRead = (findMany.mock.calls as unknown as [{ where: Row; select: Row }][])
      .filter(([query]) => query.select.text)
      .map(([query]) => query.where.id);
    expect(bodiesRead).toEqual([{ in: ["email-1"] }]);
  });

  it("answers a run's card for a site from the inbox only once in that run", async () => {
    const { deliver, answerRunInput } = inbox({
      effects: { "emailed-code:run:run-1:example.test": { runId: "run-1" } },
    });
    await deliver();
    expect(answerRunInput).not.toHaveBeenCalled();
  });

  it.each<[string, Record<string, string | null>]>([
    ["was not seen", { "run-1": null }],
    ["was on another origin", { "run-1": "https://www.example.test" }],
  ])("leaves the card for the owner when the run's page %s", async (_name, pages) => {
    const { deliver, answerRunInput } = inbox({ pages });
    await deliver();
    expect(answerRunInput).not.toHaveBeenCalled();
  });

  it("looks only at the run it is asked about", async () => {
    const { deliver, answerRunInput } = inbox({
      runs: [waitingRun(), waitingRun({ id: "run-2", threadId: "thread-2" })],
      cards: { "run-1": codeCard(), "run-2": codeCard("https://bank.test") },
      emails: [codeEmail(), codeEmail({ id: "email-2", fromAddress: "no-reply@bank.test" })],
    });
    await deliver("run-2");
    expect(answerRunInput).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ runId: "run-2", fromEmail: "email-2" }),
    );
  });

  it("skips a newer email with no code for an older one with a code", async () => {
    const { deliver, answerRunInput } = inbox({
      emails: [
        codeEmail({ id: "email-2", text: "Welcome! Your account is ready." }),
        codeEmail({ receivedAt: ago(10 * 1000) }),
      ],
    });
    await deliver();
    expect(answerRunInput).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ fromEmail: "email-1" }),
    );
  });

  it("skips an email holding two codes", async () => {
    const { deliver, answerRunInput } = inbox({
      emails: [
        codeEmail({ id: "email-2", text: "Your code is 731905. Your old code 112233 expired." }),
        codeEmail({ receivedAt: ago(10 * 1000) }),
      ],
    });
    await deliver();
    expect(answerRunInput).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ fromEmail: "email-1" }),
    );
  });

  it("answers nothing when two emails from the site hold different codes", async () => {
    const { deliver, answerRunInput } = inbox({
      emails: [
        codeEmail({ id: "email-2", text: "Your verification code is 731905." }),
        codeEmail({ receivedAt: ago(10 * 1000) }),
      ],
    });
    await deliver();
    expect(answerRunInput).not.toHaveBeenCalled();
  });

  it("takes the newest of two emails with the same code", async () => {
    const { deliver, answerRunInput } = inbox({
      emails: [codeEmail({ id: "email-2" }), codeEmail({ receivedAt: ago(10 * 1000) })],
    });
    await deliver();
    expect(answerRunInput).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ fromEmail: "email-2" }),
    );
  });

  it.each([
    ["victim.duckdns.org", "evil.duckdns.org"],
    ["evil.duckdns.org", "victim.duckdns.org"],
  ])(
    "never takes mail from %s for a page on %s, both under a shared suffix",
    async (from, page) => {
      const { deliver, answerRunInput } = inbox({
        cards: { "run-1": codeCard(`https://${page}`) },
        emails: [codeEmail({ fromAddress: `no-reply@${from}` })],
      });
      await deliver();
      expect(answerRunInput).not.toHaveBeenCalled();
    },
  );

  it("takes mail from a site under a shared suffix for its own page", async () => {
    const { deliver, answerRunInput } = inbox({
      cards: { "run-1": codeCard("https://login.victim.duckdns.org") },
      emails: [codeEmail({ fromAddress: "no-reply@victim.duckdns.org" })],
    });
    await deliver();
    expect(answerRunInput).toHaveBeenCalledOnce();
  });

  it.each([
    "yahoo.com",
    "gmx.de",
    "web.de",
    "yandex.ru",
    "mail.ru",
    "yahoo.co.jp",
    "hotmail.co.uk",
    "naver.com",
    "zoho.com",
  ])(
    "leaves the card for a sign-in page on the public mailbox domain %s, whichever mailbox has the mail",
    async (domain) => {
      // Anyone with an address there can send signed mail from that domain.
      publishKeys();
      const recent = vi.fn(async () => ({
        messages: [await connectedMail({ from: `no-reply@${domain}`, code: CODE })],
      }));
      const { deliver, answerRunInput } = inbox({
        cards: { "run-1": codeCard(`https://login.${domain}`) },
        emails: [codeEmail({ fromAddress: `no-reply@${domain}` })],
        connectedMailCodes: true,
        connected: { recent },
      });
      expect(await deliver("run-1")).toBe(0);
      expect(answerRunInput).not.toHaveBeenCalled();
      expect(recent).not.toHaveBeenCalled();
    },
  );

  it("never takes mail another bot on this server sent", async () => {
    const { deliver, answerRunInput } = inbox({
      cards: { "run-1": codeCard("https://login.bots.test") },
      emails: [codeEmail({ fromAddress: "other-bot@bots.test" })],
    });
    await deliver();
    expect(answerRunInput).not.toHaveBeenCalled();
  });

  it.each<[string, Row]>([
    ["another bot's message", { trigger: "bot_message" }],
    ["a group", { thread: { groupId: "group-1", externalConversationId: null } }],
    [
      "a messaging channel",
      {
        trigger: "messaging",
        sourceMessage: {
          blocks: [{ kind: "channel_message", channelId: "channel-1" }],
          clientNonce: null,
        },
      },
    ],
    [
      "team chat with someone besides the owner",
      { trigger: "messaging", thread: { groupId: null, externalConversationId: "conversation-1" } },
    ],
  ])("leaves the card for the owner in a run for %s", async (_name, overrides) => {
    const { deliver, answerRunInput } = inbox({ runs: [waitingRun(overrides)] });
    await deliver();
    expect(answerRunInput).not.toHaveBeenCalled();
  });

  it("does not fail the email when the lookup fails", async () => {
    const { deliver, prisma, answerRunInput } = inbox();
    prisma.run.findMany.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(deliver()).resolves.toBe(0);
    expect(answerRunInput).not.toHaveBeenCalled();
  });
});

describe("emailMayAnswer", () => {
  const rule = { site: "example.test", botEmailDomain: "bots.test", mailbox: "owner@example.net" };
  const ok = {
    fromAddress: "no-reply@example.test",
    verified: true,
    mailingList: false,
    recipients: ["Owner@Example.net"],
  };

  it("takes signed mail from the site's domain to the mailbox itself", () => {
    expect(emailMayAnswer(ok, rule)).toBe(true);
    expect(emailMayAnswer({ ...ok, fromAddress: "codes@mail.example.test" }, rule)).toBe(true);
    expect(
      emailMayAnswer({ ...ok, recipients: ["x@example.net", "owner@example.net"] }, rule),
    ).toBe(true);
    expect(emailMayAnswer(ok, { site: "example.test", botEmailDomain: undefined })).toBe(true);
  });

  it("refuses mail that is not signed by its From domain, or came through a list", () => {
    expect(emailMayAnswer({ ...ok, verified: false }, rule)).toBe(false);
    expect(emailMayAnswer({ ...ok, mailingList: true }, rule)).toBe(false);
    // Saved before lists were told apart: it may have come through one.
    expect(emailMayAnswer({ ...ok, mailingList: null }, rule)).toBe(false);
    expect(emailMayAnswer({ ...ok, fromAddress: null }, rule)).toBe(false);
  });

  it("refuses mail for a sign-in page on a public mailbox domain", () => {
    const email = { ...ok, fromAddress: "no-reply@outlook.com" };
    expect(emailMayAnswer(email, { ...rule, site: "outlook.com" })).toBe(false);
  });

  it("refuses mail from another site, or from a bot on this server", () => {
    expect(emailMayAnswer({ ...ok, fromAddress: "no-reply@other.test" }, rule)).toBe(false);
    expect(emailMayAnswer({ ...ok, fromAddress: "helper@bots.test" }, rule)).toBe(false);
    expect(emailMayAnswer(ok, { ...rule, site: "login.example.test" })).toBe(false);
  });

  it("refuses mail in a connected mailbox that was not sent to that mailbox", () => {
    expect(emailMayAnswer({ ...ok, recipients: ["someone@example.net"] }, rule)).toBe(false);
    expect(emailMayAnswer({ ...ok, recipients: [] }, rule)).toBe(false);
  });
});

/** The claim on a message in a connected mailbox: on the message in that mailbox. */
const connectedClaim = (messageId: string, mailbox = "owner@example.net") =>
  `emailed-code:connected:${createHash("sha256").update(`${mailbox}:${messageId}`).digest("base64url")}`;

describe("a code the site emailed to the mail the owner connected", () => {
  const CONNECTED_CLAIM = connectedClaim("m1");

  it("answers the card from it when the bot's inbox has nothing, and claims the message", async () => {
    publishKeys();
    const { deliver, answerRunInput, effects, recent } = inbox({
      emails: [],
      connectedMailCodes: true,
      connected: { recent: async () => ({ messages: [await connectedMail()] }) },
    });
    expect(await deliver("run-1")).toBe(1);
    expect(answerRunInput).toHaveBeenCalledWith(
      expect.objectContaining({ answer: CODE, fromEmail: CONNECTED_CLAIM, runId: "run-1" }),
    );
    expect(effects.get(CONNECTED_CLAIM)).toMatchObject({ runId: "run-1", kind: "emailed_code" });
    expect(effects.get("emailed-code:run:run-1:example.test")).toMatchObject({ runId: "run-1" });
    expect(recent).not.toHaveBeenCalled();
  });

  it("asks the reader for the site's newest mail in the window, scoped to the one connection", async () => {
    publishKeys();
    const { deliver, readerFor, prisma } = inbox({
      emails: [],
      connectedMailCodes: true,
      connections: [
        mailConnection(),
        mailConnection({ id: "connection-2", provider: "github", displayName: "Code" }),
        mailConnection({ id: "connection-3", status: "revoked" }),
      ],
    });
    const recent = vi.fn(async () => ({ messages: [await connectedMail()] }));
    readerFor.mockImplementation((connection) =>
      connection.id === "connection-1"
        ? { mailbox: async () => "owner@example.net", recent }
        : undefined,
    );
    expect(await deliver("run-1")).toBe(1);
    expect(prisma.connection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-1", spaceId: "space-1" } }),
    );
    expect(readerFor.mock.calls.map(([connection]) => connection.id)).toEqual([
      "connection-1",
      "connection-2",
    ]);
    expect(recent).toHaveBeenCalledTimes(1);
    const [context, query] = recent.mock.calls[0] as unknown as [
      {
        userId: string;
        spaceId: string;
        botId: string;
        connectedConnections: Array<{ id: string }>;
      },
      { fromDomain: string; after: Date; limit: number },
    ];
    expect(context).toMatchObject({ userId: "user-1", spaceId: "space-1", botId: "bot-1" });
    expect(context.connectedConnections.map((connection) => connection.id)).toEqual([
      "connection-1",
    ]);
    expect(query).toEqual({ fromDomain: "example.test", after: expect.any(Date), limit: 5 });
    // The window opens five minutes before the request, which the card fixture made a minute ago.
    const windowAge = Date.now() - query.after.getTime();
    expect(windowAge).toBeGreaterThanOrEqual(EMAILED_CODE_WINDOW_MS + 60_000 - 5_000);
    expect(windowAge).toBeLessThanOrEqual(EMAILED_CODE_WINDOW_MS + 65_000);
  });

  it("does not read it unless the owner turned that on", async () => {
    const { deliver, readerFor, answerRunInput } = inbox({ emails: [], connectedMailCodes: false });
    expect(await deliver("run-1")).toBe(0);
    expect(readerFor).not.toHaveBeenCalled();
    expect(answerRunInput).not.toHaveBeenCalled();
  });

  it("does not read it when mail arrives, only when the run asks", async () => {
    const { deliver, readerFor } = inbox({ emails: [], connectedMailCodes: true });
    expect(await deliver()).toBe(0);
    expect(readerFor).not.toHaveBeenCalled();
  });

  it("takes the bot's own inbox first and never reads the connected mail for the same request", async () => {
    const { deliver, answerRunInput, readerFor } = inbox({ connectedMailCodes: true });
    expect(await deliver("run-1")).toBe(1);
    expect(answerRunInput).toHaveBeenCalledWith(expect.objectContaining({ fromEmail: "email-1" }));
    expect(readerFor).not.toHaveBeenCalled();
  });

  it("takes no code from the connected mail for a site this run already took one for", async () => {
    publishKeys();
    const { deliver, readerFor } = inbox({
      emails: [],
      connectedMailCodes: true,
      effects: { "emailed-code:run:run-1:example.test": { runId: "run-1" } },
      connected: { recent: async () => ({ messages: [await connectedMail()] }) },
    });
    expect(await deliver("run-1")).toBe(0);
    expect(readerFor).not.toHaveBeenCalled();
  });

  it("never takes a message another run claimed", async () => {
    publishKeys();
    const { deliver, answerRunInput } = inbox({
      emails: [],
      connectedMailCodes: true,
      effects: { [CONNECTED_CLAIM]: { runId: "run-9" } },
      connected: { recent: async () => ({ messages: [await connectedMail()] }) },
    });
    expect(await deliver("run-1")).toBe(0);
    expect(answerRunInput).not.toHaveBeenCalled();
  });

  it.each([
    [
      "is not signed by its From domain",
      { signed: true as const, from: "no-reply@example.test", headers: [] },
    ],
    ["came through a mailing list", { headers: ["List-Id: <news.example.test>"] }],
    ["came from another site", { from: "no-reply@other.test" }],
    ["was not sent to the mailbox", { to: "someone-else@example.net" }],
  ])("leaves the card when the mail %s", async (reason, options) => {
    publishKeys();
    const message = await connectedMail(options);
    if (reason.startsWith("is not signed"))
      // Signed, then changed: the signature no longer holds.
      message.raw = new TextEncoder().encode(
        new TextDecoder().decode(message.raw).replace("verification", "sign-in"),
      );
    const { deliver, answerRunInput } = inbox({
      emails: [],
      connectedMailCodes: true,
      connected: { recent: async () => ({ messages: [message] }) },
    });
    expect(await deliver("run-1")).toBe(0);
    expect(answerRunInput).not.toHaveBeenCalled();
  });

  it("answers nothing when two messages hold different codes, and takes the newest of equal ones", async () => {
    publishKeys();
    const differing = inbox({
      emails: [],
      connectedMailCodes: true,
      connected: {
        recent: async () => ({
          messages: [
            await connectedMail({ id: "m1" }),
            await connectedMail({ id: "m2", code: "110022" }),
          ],
        }),
      },
    });
    expect(await differing.deliver("run-1")).toBe(0);
    const same = inbox({
      emails: [],
      connectedMailCodes: true,
      connected: {
        recent: async () => ({
          messages: [await connectedMail({ id: "m1" }), await connectedMail({ id: "m2" })],
        }),
      },
    });
    expect(await same.deliver("run-1")).toBe(1);
    expect(same.effects.has(CONNECTED_CLAIM)).toBe(true);
    expect(same.effects.has(connectedClaim("m2"))).toBe(false);
  });

  // The rule for which message may answer a request: one that arrived in the window after the
  // last answered secret request of the bot or of any run of the mailbox's owner in the Space,
  // passed its signature check, was not sent from the mailbox's own domain, and that no run took
  // a code from, in that mailbox through any connection. A message that cannot be judged (no
  // arrival time, a signature check that failed for now) fails the whole look, so the card opens
  // rather than an older message answering in its place; so does a bot inbox that holds the
  // site's mail but no one code, or more mail than it reads. Each row is the newest of two
  // messages holding the same code; the older one may answer.
  it.each<
    [state: string, newest: Parameters<typeof connectedMail>[0], extra: Row, taken: string | null]
  >([
    ["newer than the last answer, verified and unclaimed", {}, {}, "m2"],
    ["received before the last answer", { receivedAt: ago(40 * 1000) }, {}, "m1"],
    ["received at an unknown time", { receivedAt: null }, {}, null],
    ["not signed by its sender", { signed: false }, {}, "m1"],
    ["signed, with a signature that cannot be checked for now", { selector: "s2" }, {}, null],
    ["taken by another run", {}, { effects: { [connectedClaim("m2")]: { runId: "run-9" } } }, "m1"],
    [
      "received before the owner answered another bot's request",
      { receivedAt: ago(40 * 1000) },
      { answeredIn: { botId: "bot-2", userId: "user-1" } },
      "m1",
    ],
    [
      "from the mailbox's own domain, which is the page's site",
      { to: "owner@example.test" },
      { mailbox: "owner@example.test" },
      null,
    ],
    [
      "found while the bot's inbox holds two different codes from the site",
      {},
      {
        emails: [
          codeEmail({ receivedAt: ago(5 * 1000) }),
          codeEmail({
            id: "email-2",
            key: "dkim:signature-2",
            text: "Your verification code is 731905.",
            receivedAt: ago(6 * 1000),
          }),
        ],
      },
      null,
    ],
    [
      "found while the bot's inbox is past its read limit",
      {},
      {
        emails: Array.from({ length: EMAIL_READ_LIMIT }, (_, index) =>
          codeEmail({
            id: `other-${index}`,
            key: `dkim:other-${index}`,
            fromAddress: `news-${index}@elsewhere.test`,
            receivedAt: ago(5 * 1000 + index),
          }),
        ),
      },
      null,
    ],
    [
      "taken by another run through another connection to the same mailbox",
      {},
      {
        connections: [mailConnection({ id: "connection-2" })],
        effects: { [connectedClaim("m2")]: { runId: "run-9" } },
      },
      "m1",
    ],
  ])(
    "takes the code from the right message when the newest is %s",
    async (_state, newest, extra, taken) => {
      publishKeys();
      vi.spyOn(getLogger(), "warn").mockImplementation(() => undefined);
      const { deliver, effects } = inbox({
        emails: [],
        connectedMailCodes: true,
        answeredAt: ago(30 * 1000),
        connected: {
          recent: async () => ({
            messages: [
              await connectedMail({ id: "m2", ...newest }),
              await connectedMail({ id: "m1", receivedAt: ago(20 * 1000) }),
            ],
          }),
        },
        ...extra,
      });
      expect(await deliver("run-1")).toBe(taken ? 1 : 0);
      const takenNow = ["m1", "m2"].filter(
        (id) => effects.get(connectedClaim(id))?.runId === "run-1",
      );
      expect(takenNow).toEqual(taken ? [taken] : []);
    },
  );

  it("reads no mailbox once the owner turned the switch off, though the attempt began with it on", async () => {
    publishKeys();
    const { deliver, readerFor, recent } = inbox({
      emails: [],
      connectedMailCodes: true,
      switchedOff: true,
      connected: { recent: async () => ({ messages: [await connectedMail()] }) },
    });
    expect(await deliver("run-1")).toBe(0);
    expect(readerFor).not.toHaveBeenCalled();
    expect(recent).not.toHaveBeenCalled();
  });

  it("stops reading a mailbox whose search never runs out, and leaves the card", async () => {
    vi.spyOn(getLogger(), "warn").mockImplementation(() => undefined);
    const recent = vi.fn(async (_context: unknown, query: { page?: string }) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return { messages: [], next: String(Number(query.page ?? 0) + 1) };
    });
    const { deliver } = inbox({ emails: [], connectedMailCodes: true, connected: { recent } });
    expect(await deliver("run-1")).toBe(0);
    const calls = recent.mock.calls.length;
    expect(calls).toBeLessThanOrEqual(CONNECTED_MAIL_PAGE_LIMIT);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(recent).toHaveBeenCalledTimes(calls);
  });

  it("skips a message received before another request was answered", async () => {
    publishKeys();
    const { deliver } = inbox({
      emails: [],
      connectedMailCodes: true,
      answeredAt: ago(30 * 1000),
      connected: {
        recent: async () => ({ messages: [await connectedMail({ receivedAt: ago(45 * 1000) })] }),
      },
    });
    expect(await deliver("run-1")).toBe(0);
  });

  it.each<
    [outcome: "success" | "failure", connected: () => Promise<Partial<ConnectedMailReader> | Error>]
  >([
    [
      "success",
      async () => {
        const message = await connectedMail();
        return { recent: async () => ({ messages: [message] }) };
      },
    ],
    ["failure", async () => new Error("secret-looking message text 482913")],
  ])(
    "records in the audit log each mailbox it read for a code, with its %s",
    async (outcome, connected) => {
      publishKeys();
      const rows: Row[] = [];
      installAuditEventStore({
        auditEvent: { createMany: async ({ data }: { data: Row[] }) => rows.push(...data) },
        space: { findUnique: async () => ({ organizationId: "org-1", name: "Home" }) },
        user: { findUnique: async () => null },
        member: { findMany: async () => [] },
      } as never);
      try {
        const { deliver } = inbox({
          emails: [],
          connectedMailCodes: true,
          connected: await connected(),
        });
        await deliver("run-1");
      } finally {
        installAuditEventStore(undefined);
      }
      expect(rows).toEqual([
        expect.objectContaining({
          action: "connected_mail.read_for_code",
          actorType: "bot",
          actorId: "bot-1",
          targetType: "connection",
          targetId: "connection-1",
          runId: "run-1",
          spaceId: "space-1",
          outcome,
        }),
      ]);
      expect(JSON.stringify(rows)).not.toContain(CODE);
    },
  );

  it("leaves the card, logging only the error's name, when the mail cannot be read", async () => {
    const warn = vi.spyOn(getLogger(), "warn").mockImplementation(() => undefined);
    const { deliver, answerRunInput } = inbox({
      emails: [],
      connectedMailCodes: true,
      connected: new Error("secret-looking message text 482913"),
    });
    expect(await deliver("run-1")).toBe(0);
    expect(answerRunInput).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("connected mail could not be read for a code", {
      errorName: "Error",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("482913");
  });

  it("leaves the card when what the mailbox returns cannot be read as mail", async () => {
    publishKeys();
    const { deliver } = inbox({
      emails: [],
      connectedMailCodes: true,
      connected: {
        recent: async () => ({
          messages: [
            { id: "m1", raw: new TextEncoder().encode("\u0000??"), receivedAt: new Date() },
          ],
        }),
      },
    });
    expect(await deliver("run-1")).toBe(0);
  });
});
