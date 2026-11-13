import { createHash, generateKeyPairSync } from "node:crypto";
import { promises as dnsPromises } from "node:dns";
import type {
  ConnectedConnector,
  ConnectedMailListing,
  ConnectedMailSource,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { CODE_REQUEST_LIMIT, installAuditEventStore } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { dkimSign } from "mailauth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposioConnector } from "./composio-connector.js";
import { FakeComposioClient } from "./composio-fake.js";
import { composioMailSource } from "./composio-mail.js";
import { ConnectorRegistry } from "./connector-registry.js";
import {
  answerCodeCardsFromInbox,
  CONNECTED_MAIL_LIMIT,
  CONNECTED_MAIL_MAX_BYTES,
  CONNECTED_MAIL_PAGE_LIMIT,
  EMAIL_READ_LIMIT,
  EMAIL_SEARCH_LIMIT,
  EMAILED_CODE_WINDOW_MS,
  emailedCodeWindow,
  emailMayAnswer,
  readsBotInbox,
  takeEmailedCode,
} from "./emailed-code.js";
import { readInboundEmail } from "./inbound-email.js";

const ORIGIN = "https://example.test";
const CODE = "482913";
/** The claim on a message, by its key: the same for every copy of it, in whichever mailbox. */
const digest = (text: string) => createHash("sha256").update(text).digest("base64url");
const claimOn = (key: string) => `emailed-code:message:${digest(key)}`;
const EMAIL_CLAIM = claimOn("dkim:signature-1");
const bot = { id: "bot-1", userId: "user-1" };
const ago = (ms: number) => new Date(Date.now() - ms);

type Row = Record<string, unknown>;

/**
 * A message a connected mailbox holds: as received, with what its provider tells of it without
 * handing it over. The provider tells the sender its From names and the message's size unless
 * given; null is a provider that does not tell.
 */
type Held = {
  id: string;
  raw: Uint8Array;
  receivedAt?: Date;
  from?: string | null;
  size?: number | null;
  /** Its reader hands it over whatever limit the read was given. */
  unchecked?: boolean;
};
/** One page of what a test's mailbox lists. */
type HeldPage = { messages: Held[]; next?: string };
type Recent = (
  context: unknown,
  query: { fromDomain: string; after: Date; limit: number; page?: string },
) => Promise<HeldPage>;

/** A bot whose owner's run waits on a code card, and the mail that just came in. */
function inbox(
  options: {
    runs?: Row[];
    cards?: Record<string, Row>;
    emails?: Row[];
    /** When another code request was answered. */
    answeredAt?: Date;
    /** The run that request was in: the bot's own run unless given. */
    answeredIn?: { botId: string; userId: string };
    /** The page that request asked a code for: the card's unless given; null for no code. */
    answeredFor?: string | null;
    /** That request's id: another run's unless given. */
    answeredRequest?: string;
    /** The connected mailbox's own address. */
    mailbox?: string;
    answered?: boolean | Error;
    /** The origin each run's browser was on when it asked; absent means it was not seen. */
    pages?: Record<string, string | null>;
    /** Effects already recorded, by idempotency key. */
    effects?: Record<string, Row>;
    /** The owner's connections in the Space, and what each one's mailbox holds. */
    connections?: Row[];
    connected?: { recent?: Recent } | Error;
    /** The real source of readers, in place of the mailbox above. */
    source?: ConnectedMailSource;
    /** The inbox is encrypted: its mail is found by the hashed words it holds, not by its text. */
    encrypted?: boolean;
    inboxSpaceId?: string;
    /** Whether the bot may read the owner's connected mail for codes. */
    connectedMailCodes?: boolean;
    /** The owner turned that off after the attempt started. */
    switchedOff?: boolean;
    /** When each run asked for its code: a minute ago unless given. */
    requestedAt?: Record<string, Date>;
    /** The origin a run asked a code for, for a run whose request shows no card yet. */
    asking?: Record<string, string>;
    /** The runs whose call holds its request while it works on it, instead of leaving it open. */
    held?: string[];
  } = {},
) {
  const runs = options.runs ?? [waitingRun()];
  const cards = options.cards ?? { "run-1": codeCard() };
  const emails = options.emails ?? [codeEmail()];
  const effects = new Map<string, Row>(Object.entries(options.effects ?? {}));
  /** The runs whose cards mail answered. */
  const answered: string[] = [];
  /** Each run's code request still waiting for its answer, with or without a card. */
  const openRequests = () =>
    runs.flatMap((run) => {
      const id = String(run.id);
      const card = cards[id]?.status === "answered" ? undefined : cards[id];
      const origin = options.asking?.[id] ?? (card?.oneTimeCode as Row | undefined)?.origin;
      const createdAt = options.requestedAt?.[id] ?? ago(60 * 1000);
      const status = options.held?.includes(id) ? "executing" : "intended";
      return origin ? [{ run, request: { oneTimeCode: { origin } }, createdAt, status }] : [];
    });
  for (const run of runs) {
    const id = String(run.id);
    const page = options.pages
      ? options.pages[id]
      : ((cards[id]?.oneTimeCode as Row)?.origin ?? null);
    if (page)
      effects.set(`emailed-code:page:request-${id}`, { runId: id, request: { origin: page } });
  }
  const answeredIn = options.answeredIn ?? { botId: bot.id, userId: bot.userId };
  /** The code requests a question across Spaces reads: answered ones, or the open ones. */
  const codeRequests = (where: {
    id?: { not: string };
    status: string | { in: string[] } | { not: string };
    runId?: { not: string };
    createdAt?: { gte: Date; lte: Date };
    updatedAt?: { gte: Date };
    request?: { string_contains: string };
    run: {
      status?: { in: string[] };
      createdAt?: { lte: Date };
      OR: [{ botId: string }, { userId: string }];
    };
  }) => {
    const [{ botId }, { userId }] = where.run.OR;
    const shares = (run: Row) => run.botId === botId || run.userId === userId;
    const wanted = where.status;
    const open = typeof wanted === "string" ? [wanted] : "in" in wanted ? wanted.in : undefined;
    const requests =
      open !== undefined
        ? openRequests()
            .filter(
              ({ run, createdAt, status }) =>
                open.includes(status) &&
                run.id !== where.runId?.not &&
                where.run.status?.in.includes(String(run.status)) &&
                (run.createdAt as Date) <= where.run.createdAt!.lte &&
                createdAt >= where.createdAt!.gte &&
                createdAt <= where.createdAt!.lte &&
                shares(run),
            )
            .map(({ request }) => ({ request, updatedAt: new Date() }))
        : options.answeredAt &&
            options.answeredAt >= where.updatedAt!.gte &&
            shares(answeredIn) &&
            (options.answeredRequest ?? "request-elsewhere") !== where.id?.not
          ? [
              {
                request:
                  options.answeredFor === null
                    ? { label: "Password" }
                    : { oneTimeCode: { origin: options.answeredFor ?? ORIGIN } },
                updatedAt: options.answeredAt,
              },
            ]
          : [];
    // As the database narrows them: to requests whose page holds the site's name.
    const { string_contains: name } = where.request ?? {};
    return requests.filter(
      ({ request }) =>
        name === undefined ||
        String((request as { oneTimeCode?: Row }).oneTimeCode?.origin ?? "").includes(name),
    );
  };
  const answerRunInput = vi.fn(
    async ({
      runId,
      claimEmail,
    }: {
      runId: string;
      claimEmail?: (tx: unknown) => Promise<void>;
    }) => {
      if (options.answered === false) return false;
      // The email is taken in the answer's own transaction, as the database does it.
      return (prisma.$transaction as (fn: (tx: unknown) => Promise<boolean>) => Promise<boolean>)(
        async (tx) => {
          await claimEmail?.(tx);
          if (options.answered instanceof Error) throw options.answered;
          answered.push(runId);
          return true;
        },
      );
    },
  );
  const enqueue = vi.fn(async (_job: unknown) => undefined);
  const prisma: Record<string, unknown> = {
    ...(options.encrypted
      ? {
          $contentEncryption: () => ({
            messageSearchTokens: async (spaceId: string, text: string) =>
              spaceId === (options.inboxSpaceId ?? "space-1") ? [hashedWords(text)] : [[-1]],
          }),
        }
      : {}),
    run: {
      findMany: vi.fn(async ({ where }: { where: Row & { id?: string | { not: string } } }) =>
        runs.filter(
          (run) =>
            (where.id === undefined ||
              (typeof where.id === "string" ? run.id === where.id : run.id !== where.id.not)) &&
            ["status", "botId", "userId"].every(
              (key) => where[key] === undefined || run[key] === where[key],
            ),
        ),
      ),
    },
    message: {
      findMany: async ({ where }: { where: { runId: string } }) =>
        cards[where.runId] ? [{ id: `card-${where.runId}`, blocks: [cards[where.runId]] }] : [],
    },
    externalEffect: {
      findFirst: vi.fn(async ({ where }: { where: { runId: string } }) =>
        cards[where.runId]
          ? {
              id: `request-${where.runId}`,
              createdAt: options.requestedAt?.[where.runId] ?? ago(60 * 1000),
            }
          : null,
      ),
      findUnique: async ({ where }: { where: { idempotencyKey: string } }) =>
        effects.get(where.idempotencyKey) ?? null,
      findMany: async ({ where, take }: { where: Row; take?: number }) =>
        where.kind === "request_secret"
          ? codeRequests(where as Parameters<typeof codeRequests>[0]).slice(0, take)
          : (where.idempotencyKey as { in: string[] }).in
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
    // The settings a transaction's connection holds, which a read across Spaces saves and restores.
    $queryRaw: async () => [{ bypass: "off", key: "", login: "app" }],
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
        where: {
          id?: { in: string[] };
          receivedAt: { gte: Date; lte: Date };
          OR?: Array<{ fromAddress?: { contains: string }; searchTokens?: { hasEvery: number[] } }>;
        };
        cursor?: { id: string };
        skip?: number;
        take?: number;
      }) => {
        if (where.id) return emails.filter((email) => where.id?.in.includes(String(email.id)));
        // As the database narrows them: an encrypted email by the hashed words it holds, a
        // plaintext one by what its sender's address holds.
        const named = (email: Row) =>
          !where.OR ||
          where.OR.some(({ fromAddress, searchTokens }) =>
            options.encrypted
              ? searchTokens?.hasEvery.every((token) => wordTokens(email).includes(token))
              : fromAddress &&
                String(email.fromAddress).toLowerCase().includes(fromAddress.contains),
          );
        const inWindow = emails
          .filter(
            (email) =>
              (email.receivedAt as Date) >= where.receivedAt.gte &&
              (email.receivedAt as Date) <= where.receivedAt.lte &&
              named(email),
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
        spaceId: options.inboxSpaceId ?? "space-1",
        connectedMailCodes: Boolean(options.connectedMailCodes) && !options.switchedOff,
      }),
    },
    connection: {
      findMany: vi.fn(async () => options.connections ?? [mailConnection()]),
    },
  };
  const mailbox = vi.fn(async () => options.mailbox ?? "owner@example.net");
  const held = new Map<string, Held>();
  /** The ids of the messages whose content was fetched, in order. */
  const reads: string[] = [];
  const holds: Recent =
    options.connected instanceof Error
      ? async () => Promise.reject(options.connected)
      : (options.connected?.recent ?? (async () => ({ messages: [] })));
  // The mailbox as its reader shows it: a listing tells of each message, and only a read of
  // one hands its content over, refusing what is larger than it may hold.
  const recent = vi.fn(async (context: unknown, query: Parameters<Recent>[1]) => {
    const page = await holds(context, query);
    const messages = page.messages.map((message): ConnectedMailListing => {
      held.set(message.id, message);
      const written = new TextDecoder().decode(message.raw.subarray(0, 2048));
      const from =
        message.from === undefined
          ? /^From:.*?<?([^\s<>]+@[^\s<>]+)>?\s*$/im.exec(written)?.[1]?.toLowerCase()
          : message.from;
      const size = message.size === undefined ? message.raw.byteLength : message.size;
      return {
        id: message.id,
        ...(from ? { from } : {}),
        ...(size === null ? {} : { size }),
        ...(message.receivedAt ? { receivedAt: message.receivedAt } : {}),
      };
    });
    return { messages, ...(page.next ? { next: page.next } : {}) };
  });
  const read = vi.fn(async (_context: unknown, id: string, maxBytes: number) => {
    reads.push(id);
    const { raw, unchecked } = held.get(id)!;
    if (raw.byteLength > maxBytes && !unchecked)
      throw new Error("A listed message is larger than it may hold");
    return raw;
  });
  const readerFor = vi.fn((connection: ConnectedConnector) =>
    connection.connectorId === "composio" && connection.externalId === "GMAIL"
      ? { mailbox, recent, read }
      : undefined,
  );
  const deliver = (runId?: string) =>
    answerCodeCardsFromInbox(
      {
        prisma: prisma as unknown as PrismaClient,
        events: { answerRunInput } as never,
        jobs: { enqueue },
        botEmailDomain: "bots.test",
        connectedMail: options.connectedMailCodes ? (options.source ?? { readerFor }) : undefined,
      },
      bot,
      runId,
    );
  /** A run asks for its code, as request_secret does: what it kept, or nothing. */
  const ask = (
    runId: string,
    sources: { inbox?: boolean; connected?: boolean; origin?: string } = {},
  ) =>
    takeEmailedCode(
      prisma as unknown as PrismaClient,
      {
        botId: bot.id,
        spaceId: "space-1",
        runId,
        requestId: `request-${runId}`,
        userId: bot.userId,
        origin: sources.origin ?? ORIGIN,
        // The run started ten minutes ago, as waitingRun says, and asks now.
        window: emailedCodeWindow(new Date(), ago(10 * 60 * 1000)),
        botEmailDomain: "bots.test",
        sources: {
          inbox: sources.inbox ?? true,
          connected: sources.connected ? (options.source ?? { readerFor }) : undefined,
        },
      },
      // Kept in a transaction that makes the claim, as the code is stored.
      (found, claim) =>
        (prisma.$transaction as (fn: (tx: never) => Promise<string>) => Promise<string>)(
          async (tx) => {
            await claim(tx);
            return found.code;
          },
        ),
    );
  return {
    deliver,
    ask,
    answered,
    answerRunInput,
    enqueue,
    prisma: prisma as typeof prisma & {
      run: { findMany: ReturnType<typeof vi.fn> };
      connection: { findMany: ReturnType<typeof vi.fn> };
    },
    effects,
    readerFor,
    recent,
    reads,
  };
}

/** The words of a text as a blind index keeps them: a number for each, telling nothing of it. */
const hashedWords = (text: string) =>
  (text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []).map((word) =>
    createHash("sha256").update(word).digest().readInt32BE(0),
  );
/** What the index holds of an email: the words of its sender, subject and text together. */
const wordTokens = (email: Row) =>
  hashedWords([email.fromAddress, email.fromName, email.subject, email.text].join("\n"));

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
  const der = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  return {
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    record: `v=DKIM1; k=rsa; p=${der}`,
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
    /** Changed after it was signed, so its signature no longer holds. */
    tampered?: boolean;
    headers?: string[];
    /** What the mail says, instead of a sentence giving `code`. */
    text?: string;
    /** When the mailbox received it, a few seconds ago unless given; null when not told. */
    receivedAt?: Date | null;
    /** The site's key the signature names: `s2`'s lookup fails for now. */
    selector?: string;
  } = {},
): Promise<Held> {
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
    options.text ?? `Your verification code is ${options.code ?? CODE}.`,
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
    raw: new TextEncoder().encode(options.tampered ? signed.replace("Your ", "Our ") : signed),
    ...(receivedAt ? { receivedAt } : {}),
  };
}

/** The claim on a message a mailbox holds: on the message itself, by its sender's signature. */
const claimOf = async (message: Held) => claimOn((await readInboundEmail(message.raw)).key);

const BOT_ADDRESS = "helper@bots.test";
const OWNER_MAILBOX = "owner@example.net";

/** A message as delivery saves it to the bot's inbox, classified as the inbound route does. */
async function savedToInbox(message: Held): Promise<Row> {
  const email = await readInboundEmail(message.raw);
  return codeEmail({
    id: `email-${message.id}`,
    key: email.key,
    fromAddress: email.from?.address,
    verified: email.authenticated && [...email.to, ...email.cc].includes(BOT_ADDRESS),
    mailingList: email.mailingList,
    autoReplyOrBulk: email.autoReplyOrBulk,
    subject: email.subject,
    text: email.text,
    receivedAt: message.receivedAt,
  });
}

/** The three looks that take a code from mail; each rule holds on every one of them. */
const PATHS = [
  "mail arriving in the bot's inbox",
  "a request reading the bot's inbox",
  "a request reading connected mail",
] as const;
type World = NonNullable<Parameters<typeof inbox>[0]>;
type Mail = NonNullable<Parameters<typeof connectedMail>[0]> & {
  /** Another run already took this message's code. */
  claimed?: boolean;
  /** Both the bot's inbox and the owner's mailbox hold it: the site copied one on the other's. */
  inBothMailboxes?: boolean;
};

/**
 * Run-1's look on one path, over the same mail and the same other runs: on arrival it waits on
 * its card; on a request it has asked and shows no card yet. `took` says whether it got the code.
 */
async function look(path: (typeof PATHS)[number], mail: Mail[], world: World = {}) {
  publishKeys();
  vi.spyOn(getLogger(), "warn").mockImplementation(() => undefined);
  const arriving = path === PATHS[0];
  const inInbox = path !== PATHS[2];
  const messages = await Promise.all(
    mail.map((one, index) =>
      connectedMail({
        id: `m${index + 1}`,
        to: one.inBothMailboxes
          ? `${BOT_ADDRESS}, ${OWNER_MAILBOX}`
          : inInbox
            ? BOT_ADDRESS
            : OWNER_MAILBOX,
        ...one,
      }),
    ),
  );
  const held = (inMailbox: boolean) =>
    messages.filter((_message, index) => inMailbox || mail[index]?.inBothMailboxes);
  const claims = await Promise.all(messages.map(claimOf));
  const cards = { ...(arriving ? { "run-1": codeCard() } : {}), ...world.cards };
  const asking = { ...(arriving ? {} : { "run-1": ORIGIN }), ...world.asking };
  const scene = inbox({
    ...world,
    runs: [waitingRun(arriving ? {} : { status: "running" }), ...(world.runs ?? [])],
    cards,
    asking,
    emails: await Promise.all(held(inInbox).map(savedToInbox)),
    effects: {
      ...world.effects,
      ...Object.fromEntries(
        claims.flatMap((claim, index) =>
          mail[index]?.claimed ? [[claim, { runId: "run-9" }]] : [],
        ),
      ),
    },
    connectedMailCodes: true,
    connected: { recent: async () => ({ messages: held(!inInbox) }) },
  });
  if (arriving) await scene.deliver();
  const took = arriving
    ? scene.answered.includes("run-1")
    : (await scene.ask("run-1", { inbox: inInbox, connected: !inInbox })) === CODE;
  /** Run-1's request is answered: its card, or its call, is done. */
  const settle = () => {
    delete asking["run-1"];
    if (cards["run-1"]) cards["run-1"] = { ...codeCard(), status: "answered" };
  };
  return { ...scene, took, claims, settle };
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
    botId: "bot-1",
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
    autoReplyOrBulk: false,
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

  it.each([
    "https://promo.example.test",
    "https://login.example.test",
    "https://example.test:8443",
  ])("requires the owner's card answer for an unbound origin %s", async (origin) => {
    publishKeys();
    const message = await connectedMail();
    const { deliver, ask, answerRunInput } = inbox({
      cards: { "run-1": codeCard(origin) },
      connectedMailCodes: true,
      connected: { recent: async () => ({ messages: [message] }) },
    });
    expect(await deliver("run-1")).toBe(0);
    expect(await ask("run-1", { inbox: false, connected: true, origin })).toBeUndefined();
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

  it("leaves a card alone once five minutes have passed since it asked", async () => {
    // Mail that comes this long after is not the request's: the card is the owner's from then.
    const { deliver, answerRunInput, prisma } = inbox({
      requestedAt: { "run-1": ago(EMAILED_CODE_WINDOW_MS + 1000) },
    });
    const read = vi.spyOn(prisma.botEmailMessage as { findMany: () => unknown }, "findMany");
    expect(await deliver()).toBe(0);
    expect(answerRunInput).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    const still = inbox({ requestedAt: { "run-1": ago(EMAILED_CODE_WINDOW_MS - 5 * 1000) } });
    expect(await still.deliver()).toBe(1);
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
    const cards: Record<string, Row> = { "run-1": codeCard() };
    const { deliver, answerRunInput } = inbox({ runs: [waitingRun(), later], emails, cards });
    await expect(deliver()).resolves.toBe(1);
    // The bot deleted the email; the sender's relay delivers the same signed message again, and
    // a later run asks for a code from the same site.
    emails.splice(0, 1, codeEmail({ id: "email-2", receivedAt: new Date() }));
    cards["run-1"] = { ...codeCard(), status: "answered" };
    cards["run-2"] = codeCard();
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
  it("reads no more of the inbox than its read limit, and leaves the card past it", async () => {
    // Mail whose senders hold the site's name, though none is the site's: all of it is read.
    const other = others(EMAIL_READ_LIMIT, (index) => `news-${index}@example.test.elsewhere.test`);
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

  it("uses the inbox Space's encryption index for a run in another Space", async () => {
    const { deliver, answerRunInput } = inbox({ encrypted: true, inboxSpaceId: "inbox-space" });
    expect(await deliver()).toBe(1);
    expect(answerRunInput).toHaveBeenCalledWith(expect.objectContaining({ answer: CODE }));
  });

  it("denies mailbox access to webhook runs carrying the owner's user id", () => {
    expect(
      readsBotInbox({
        run: { userId: bot.userId, trigger: "webhook" },
        bot,
        thread: { groupId: null },
        nonOwnerChatRun: false,
      }),
    ).toBe(false);
  });

  // BOUNDS: the read limit is on mail that names the site. The query asks for no other, so mail
  // that does not name it, however much, is neither read nor counted, whether the inbox is
  // encrypted (found by the hashed words it holds) or not (by its sender's address).
  it.each<[inbox: string, encrypted: boolean]>([
    ["a plaintext inbox", false],
    ["an encrypted inbox", true],
  ])("in %s, takes the site's code beside more unrelated mail than a look reads", async (_, on) => {
    const other = others(EMAIL_READ_LIMIT + 50, (index) => `news-${index}@elsewhere.org`);
    const { deliver, prisma } = inbox({
      encrypted: on,
      emails: [
        codeEmail({ receivedAt: ago(60 * 1000) }),
        ...other.map((mail) =>
          codeEmail({
            id: mail.id,
            key: `dkim:${mail.id}`,
            fromAddress: mail.from,
            fromName: "News",
            text: "This week's letter.",
            receivedAt: mail.receivedAt,
          }),
        ),
      ],
    });
    const findMany = vi.spyOn(prisma.botEmailMessage as { findMany: () => unknown }, "findMany");
    await expect(deliver()).resolves.toBe(1);
    // Only the site's own email was ever read from the inbox.
    const read = (await Promise.all(findMany.mock.results.map((result) => result.value))).flat();
    expect(new Set(read.map((email) => (email as Row).id))).toEqual(new Set(["email-1"]));
  });

  it("narrows nothing for a site whose name can be written in two ways", async () => {
    const page = "https://xn--bcher-kva.test";
    const { deliver, prisma } = inbox({
      cards: { "run-1": codeCard(page) },
      emails: [codeEmail({ fromAddress: "no-reply@xn--bcher-kva.test" })],
    });
    const findMany = vi.spyOn(prisma.botEmailMessage as { findMany: () => unknown }, "findMany");
    await expect(deliver()).resolves.toBe(1);
    const [scan] = findMany.mock.calls[0] as unknown as [{ where: Row }];
    expect(scan.where).not.toHaveProperty("OR");
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
        [claimOn("dkim:taken")]: { runId: "run-9" },
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
      cards: { "run-1": codeCard("https://victim.duckdns.org") },
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
    "leaves the card for a sign-in page on the public mailbox domain %s, in any mailbox",
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
    ["a webhook", { trigger: "webhook" }],
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

  it("does not fail the email when the lookup fails, logging only the error's name", async () => {
    const logged = vi.spyOn(getLogger(), "error").mockImplementation(() => undefined);
    const { deliver, prisma, answerRunInput } = inbox();
    prisma.run.findMany.mockRejectedValueOnce(new Error("database unavailable: inbox-db"));
    await expect(deliver()).resolves.toBe(0);
    expect(answerRunInput).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledExactlyOnceWith("emailed code lookup failed", {
      errorName: "Error",
    });
  });
});

// ELIGIBILITY, what the email says: one predicate (emailMayAnswer) decides, for every look, and
// the one extractor reads its code. Each row is one message, delivered to the mailbox the path
// reads and classified there as that mailbox's mail is.
const LONG = `${"lorem ipsum dolor sit amet ".repeat(3)}\r\n`.repeat(260);
// Each row is built when its test runs, so its times are relative to that look.
const ELIGIBILITY: [kind: string, gives: boolean, row: () => [Mail, World?]][] = [
  ["a plain notice from the site", true, () => [{}]],
  ["a notice marked auto-generated", true, () => [{ headers: ["Auto-Submitted: auto-generated"] }]],
  [
    "a notice asking not to be auto-answered",
    true,
    () => [{ headers: ["Auto-Submitted: auto-generated", "X-Auto-Response-Suppress: All"] }],
  ],
  ["mail from the site's mail subdomain", false, () => [{ from: "codes@mail.example.test" }]],
  ["mail whose signature does not hold", false, () => [{ tampered: true }]],
  ["mail with no signature", false, () => [{ signed: false }]],
  ["an auto-reply", false, () => [{ headers: ["Auto-Submitted: auto-replied"] }]],
  ["a vacation reply", false, () => [{ headers: ["X-Autoreply: yes"] }]],
  ["bulk mail", false, () => [{ headers: ["Precedence: bulk"] }]],
  ["junk mail", false, () => [{ headers: ["Precedence: junk"] }]],
  ["list mail", false, () => [{ headers: ["List-Id: <news.example.test>"] }]],
  ["mail from another site", false, () => [{ from: "no-reply@other.test" }]],
  [
    "mail from a domain that only holds the site's",
    false,
    () => [{ from: "no-reply@example.test.elsewhere.test" }],
  ],
  ["mail sent to someone else", false, () => [{ to: "someone-else@example.net" }]],
  ["mail that came before the request's window", false, () => [{ receivedAt: ago(7 * 60 * 1000) }]],
  // The owner may have typed an email's code into a card: one that came before a code request
  // for the site was answered, in a run that shares the mail, is not used. Any other answer,
  // by anyone else or for anything else, says nothing of it.
  [
    "mail that came before a code request for the site was answered",
    false,
    () => [{ receivedAt: ago(40 * 1000) }, { answeredAt: ago(30 * 1000) }],
  ],
  [
    "mail that came before the owner answered another bot's code request for the site",
    false,
    () => [
      { receivedAt: ago(40 * 1000) },
      { answeredAt: ago(30 * 1000), answeredIn: { botId: "bot-2", userId: "user-1" } },
    ],
  ],
  [
    "mail that came before someone else answered another bot's code request for the site",
    true,
    () => [
      { receivedAt: ago(40 * 1000) },
      { answeredAt: ago(30 * 1000), answeredIn: { botId: "bot-9", userId: "user-2" } },
    ],
  ],
  [
    "mail that came before a code request for another site was answered",
    true,
    () => [
      { receivedAt: ago(40 * 1000) },
      { answeredAt: ago(30 * 1000), answeredFor: "https://bank.test" },
    ],
  ],
  [
    "mail that came before a request for something other than a code was answered",
    true,
    () => [{ receivedAt: ago(40 * 1000) }, { answeredAt: ago(30 * 1000), answeredFor: null }],
  ],
  [
    "mail that came after a code request for the site was answered",
    true,
    () => [{ receivedAt: ago(20 * 1000) }, { answeredAt: ago(30 * 1000) }],
  ],
  [
    "mail that came before the request's own call took hold of the request",
    true,
    () => [
      { receivedAt: ago(40 * 1000) },
      { answeredAt: ago(30 * 1000), answeredRequest: "request-run-1" },
    ],
  ],
  ["mail a run already took the code from", false, () => [{ claimed: true }]],
  ["mail holding two codes", false, () => [{ text: "Your code is 482913. Your code is 731905." }]],
  [
    "mail saying the code expired",
    false,
    () => [{ text: "Your verification code is 482913.\r\nThis code has expired." }],
  ],
  ["mail with a code too short to hide", false, () => [{ code: "4829" }]],
  ["mail longer than is kept of it", false, () => [{ text: `Your code is 482913.\r\n${LONG}` }]],
];

// ELIGIBILITY, what the database says when the code is taken: one claim (claimEmailedCode)
// decides, for every look. Mail does not say which sign-in it is for, so it answers a request
// only while that is the one open request it could be for: among the runs whose codes can be in
// the same mail (the bot's runs, whoever started them, and its owner's runs, in whichever of
// their bots), for the same site, whose window the mail came in.
const other = (overrides: Row = {}) =>
  waitingRun({ id: "run-2", threadId: "thread-2", ...overrides });
/** That many runs of another of the owner's bots, each waiting on a code card for `origin`. */
const manyOthers = (count: number, origin: string): World => {
  const ids = Array.from({ length: count }, (_, index) => `other-${index}`);
  return {
    runs: ids.map((id) => other({ id, threadId: `thread-${id}`, botId: "bot-2" })),
    cards: Object.fromEntries(ids.map((id) => [id, codeCard(origin)])),
  };
};
const OTHER_REQUESTS: [others: string, fills: boolean, world: () => World][] = [
  ["no other request", true, () => ({})],
  [
    "another run of the bot waiting on a card for the site",
    false,
    () => ({ runs: [other()], cards: { "run-2": codeCard() } }),
  ],
  [
    "a run of another of the owner's bots waiting on a card for the site",
    false,
    () => ({ runs: [other({ botId: "bot-2" })], cards: { "run-2": codeCard() } }),
  ],
  [
    "someone else's run of the owner's bot waiting on a card for the site",
    false,
    () => ({ runs: [other({ userId: "user-2" })], cards: { "run-2": codeCard() } }),
  ],
  [
    "another run that asked for the site's code and shows no card yet",
    false,
    () => ({ runs: [other({ status: "running" })], asking: { "run-2": ORIGIN } }),
  ],
  [
    "another run whose call holds its request for the site while it looks",
    false,
    () => ({
      runs: [other({ status: "running" })],
      asking: { "run-2": ORIGIN },
      held: ["run-2"],
    }),
  ],
  // A sign-in whose run has not asked for its code yet has left the server nothing to go on.
  [
    "another run of the owner's that has asked for no code",
    true,
    () => ({ runs: [other({ status: "running" })] }),
  ],
  [
    "another run waiting on a card for another host of the site",
    false,
    () => ({ runs: [other()], cards: { "run-2": codeCard("https://app.example.test") } }),
  ],
  [
    "another run waiting on a card for another site",
    true,
    () => ({ runs: [other()], cards: { "run-2": codeCard("https://bank.test") } }),
  ],
  [
    "someone else's run of another bot waiting on a card for the site",
    true,
    () => ({
      runs: [other({ userId: "user-2", botId: "bot-9" })],
      cards: { "run-2": codeCard() },
    }),
  ],
  [
    "a run whose card for the site was answered",
    true,
    () => ({ runs: [other()], cards: { "run-2": { ...codeCard(), status: "answered" } } }),
  ],
  [
    "a cancelled run whose card for the site was left open",
    true,
    () => ({ runs: [other({ status: "cancelled" })], cards: { "run-2": codeCard() } }),
  ],
  [
    "a run that started after the mail came",
    true,
    () => ({ runs: [other({ createdAt: ago(5 * 1000) })], cards: { "run-2": codeCard() } }),
  ],
  // A request blocks only mail it could take itself: one whose window is over, however long
  // its card stays open, keeps no one from a code.
  [
    "another run whose card for the site has been open since long before the mail came",
    true,
    () => ({
      runs: [other({ createdAt: ago(60 * 60 * 1000) })],
      cards: { "run-2": codeCard() },
      requestedAt: { "run-2": ago(20 * 60 * 1000) },
    }),
  ],
  [
    "another run that asked for the site's code just under five minutes before the mail came",
    false,
    () => ({
      runs: [other()],
      cards: { "run-2": codeCard() },
      requestedAt: { "run-2": ago(EMAILED_CODE_WINDOW_MS - 5 * 1000) },
    }),
  ],
  [
    "any number of open code requests for other sites",
    true,
    () => manyOthers(CODE_REQUEST_LIMIT + 50, "https://bank.test"),
  ],
  // Requests on a site whose name only holds the site's are read and set aside, up to a limit.
  [
    "as many open code requests on look-alike sites as are read",
    true,
    () => manyOthers(CODE_REQUEST_LIMIT, "https://login.notexample.test"),
  ],
  [
    "more open code requests on look-alike sites than are read",
    false,
    () => manyOthers(CODE_REQUEST_LIMIT + 1, "https://login.notexample.test"),
  ],
];

// EXTRACTION over the site's mail in the window: one reader (readOneTimeCode) reads every email
// that may answer. Those that give a code must give the same one; one that names no code says
// nothing of the others; one that is unclear, naming a code it does not give, puts them in
// doubt, so none is taken. Mail that may not answer changes nothing, whatever it says.
const WITH_OTHER_MAIL: [other: string, fills: boolean, mail: () => Mail][] = [
  ["a newer welcome email that names no code", true, () => ({ text: "Welcome! You are in." })],
  ["a newer email with the same code", true, () => ({})],
  ["a newer email with another code", false, () => ({ code: "731905" })],
  [
    "a newer email holding two codes",
    false,
    () => ({ text: "Your code is 731905. Your code is 112233." }),
  ],
  [
    "a newer email saying the previous code expired",
    false,
    () => ({ text: "Your previous code has expired." }),
  ],
  [
    "a newer email giving a new code and calling the old one expired",
    false,
    () => ({ text: "Your old code expired.\r\nYour code: 731905" }),
  ],
  ["a newer email with a code too short to take", false, () => ({ code: "4829" })],
  // A long email that names no code where it is read is a newsletter: it says nothing.
  ["a newer email longer than is read that names no code", true, () => ({ text: LONG })],
  [
    "a newer email longer than is read that gives the same code",
    false,
    () => ({ text: `Your code is ${CODE}.\r\n${LONG}` }),
  ],
  [
    "an older email saying a code expired",
    false,
    () => ({ text: "Your previous code has expired.", receivedAt: ago(30 * 1000) }),
  ],
  [
    "a newer email saying the code expired that the site did not sign",
    true,
    () => ({ text: "Your previous code has expired.", signed: false }),
  ],
  [
    "a newer email saying the code expired from another site",
    true,
    () => ({ text: "Your previous code has expired.", from: "no-reply@other.test" }),
  ],
];

describe.each(PATHS)("which mail may answer a code request, on %s", (path) => {
  it.each(WITH_OTHER_MAIL)("beside %s, takes the site's code: %s", async (kind, fills, mail) => {
    const older = { receivedAt: ago(20 * 1000) };
    const { took, effects, claims } = await look(path, [older, mail()]);
    expect(took).toBe(fills);
    // The newest email that gives the code is the one taken; otherwise none is.
    const taken = claims.filter((claim) => effects.has(claim));
    const newest = kind.includes("same code") ? claims[1] : claims[0];
    expect(taken).toEqual(fills ? [newest] : []);
  });

  it.each(ELIGIBILITY)("%s gives its code: %s", async (_kind, gives, row) => {
    const [mail, world] = row();
    const { took, effects, claims } = await look(path, [mail], world);
    expect(took).toBe(gives);
    // Taken with its claim, or not at all.
    expect(effects.get(claims[0]!)?.runId).toBe(
      gives ? "run-1" : mail.claimed ? "run-9" : undefined,
    );
  });

  it.each(OTHER_REQUESTS)("with %s, takes the site's code: %s", async (_others, fills, world) => {
    const { took, answered, effects, claims } = await look(path, [{}], world());
    expect(took).toBe(fills);
    // Mail two requests could be for answers neither: no other card is answered with it.
    expect(answered.filter((runId) => runId !== "run-1")).toEqual([]);
    expect(effects.has(claims[0]!)).toBe(fills);
  });

  it("gives a message both mailboxes hold to one run, whichever mailbox a run reads", async () => {
    // The site sent one message to the bot and to the owner: one message, one claim.
    const { took, effects, claims, ask, settle } = await look(path, [{ inBothMailboxes: true }], {
      runs: [other({ status: "running" })],
    });
    expect(took).toBe(true);
    const taken = [...effects.keys()].sort();
    // Run-1's request is answered; another run then asks, reading either mailbox.
    settle();
    expect(await ask("run-2", { inbox: true, connected: false })).toBeUndefined();
    expect(await ask("run-2", { inbox: false, connected: true })).toBeUndefined();
    expect(effects.get(claims[0]!)).toMatchObject({ runId: "run-1" });
    expect([...effects.keys()].sort()).toEqual(taken);
  });
});

describe("emailMayAnswer", () => {
  const window = emailedCodeWindow(new Date(), ago(60 * 60 * 1000));
  const rule = {
    site: "example.test",
    botEmailDomain: "bots.test",
    ...window,
    mailbox: "owner@example.net",
  };
  const ok = {
    fromAddress: "no-reply@example.test",
    verified: true,
    mailingList: false,
    autoReplyOrBulk: false,
    receivedAt: ago(10 * 1000),
    recipients: ["Owner@Example.net"],
  };

  it("takes signed mail from the site's domain to the mailbox itself", () => {
    expect(emailMayAnswer(ok, rule)).toBe(true);
    expect(emailMayAnswer({ ...ok, fromAddress: "codes@mail.example.test" }, rule)).toBe(false);
    expect(
      emailMayAnswer({ ...ok, recipients: ["x@example.net", "owner@example.net"] }, rule),
    ).toBe(true);
    const inbox = { site: "example.test", botEmailDomain: undefined, ...window };
    expect(emailMayAnswer(ok, inbox)).toBe(true);
  });

  it("refuses mail that came outside the request's window, before it or after it", () => {
    const { after, before } = window;
    // Five minutes either side of the request, and never before its run started.
    expect(before.getTime() - after.getTime()).toBe(2 * EMAILED_CODE_WINDOW_MS);
    expect(emailedCodeWindow(new Date(), ago(1000)).after.getTime()).toBeGreaterThan(
      after.getTime(),
    );
    for (const [receivedAt, may] of [
      [after, true],
      [new Date(after.getTime() - 1), false],
      [before, true],
      [new Date(before.getTime() + 1), false],
    ] as const)
      expect(emailMayAnswer({ ...ok, receivedAt }, rule)).toBe(may);
  });

  it("refuses mail that is not signed by its From domain, or came through a list", () => {
    expect(emailMayAnswer({ ...ok, verified: false }, rule)).toBe(false);
    expect(emailMayAnswer({ ...ok, mailingList: true }, rule)).toBe(false);
    // Saved before lists were told apart: it may have come through one.
    expect(emailMayAnswer({ ...ok, mailingList: null }, rule)).toBe(false);
    expect(emailMayAnswer({ ...ok, autoReplyOrBulk: true }, rule)).toBe(false);
    // Saved before auto-replies and bulk mail were told apart.
    expect(emailMayAnswer({ ...ok, autoReplyOrBulk: null }, rule)).toBe(false);
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

describe("a code the site emailed to the mail the owner connected", () => {
  it("answers the card from it when the bot's inbox has nothing, claiming it", async () => {
    publishKeys();
    const message = await connectedMail();
    const CONNECTED_CLAIM = await claimOf(message);
    const { deliver, answerRunInput, effects } = inbox({
      emails: [],
      connectedMailCodes: true,
      connected: { recent: async () => ({ messages: [message] }) },
    });
    expect(await deliver("run-1")).toBe(1);
    expect(answerRunInput).toHaveBeenCalledWith(
      expect.objectContaining({ answer: CODE, fromEmail: CONNECTED_CLAIM, runId: "run-1" }),
    );
    expect(effects.get(CONNECTED_CLAIM)).toMatchObject({ runId: "run-1", kind: "emailed_code" });
    expect(effects.get("emailed-code:run:run-1:example.test")).toMatchObject({ runId: "run-1" });
  });

  it("leaves a subdomain mailbox's peer code for the owner's manual answer", async () => {
    publishKeys();
    const origin = "https://staff.example.test";
    const card = codeCard(origin);
    const message = await connectedMail({
      from: "peer@staff.example.test",
      to: "owner@staff.example.test",
    });
    const { deliver, ask, answerRunInput, effects, enqueue } = inbox({
      emails: [],
      cards: { "run-1": card },
      mailbox: "owner@staff.example.test",
      connectedMailCodes: true,
      connected: { recent: async () => ({ messages: [message] }) },
    });
    expect(await deliver("run-1")).toBe(0);
    expect(await ask("run-1", { inbox: false, connected: true, origin })).toBeUndefined();
    expect(answerRunInput).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect([...effects.keys()]).toEqual(["emailed-code:page:request-run-1"]);
    expect(card.status).toBe("pending");
  });

  it("asks the reader for the site's newest mail in the window, on one connection", async () => {
    publishKeys();
    const message = await connectedMail();
    const { deliver, readerFor, prisma, recent, reads } = inbox({
      emails: [],
      connectedMailCodes: true,
      connections: [
        mailConnection(),
        mailConnection({ id: "connection-2", provider: "github", displayName: "Code" }),
        mailConnection({ id: "connection-3", status: "revoked" }),
      ],
      connected: { recent: async () => ({ messages: [message] }) },
    });
    expect(await deliver("run-1")).toBe(1);
    expect(reads).toEqual([message.id]);
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

  it("takes the bot's inbox first, and reads no connected mail for that request", async () => {
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
    const message = await connectedMail();
    const { deliver, answerRunInput } = inbox({
      emails: [],
      connectedMailCodes: true,
      effects: { [await claimOf(message)]: { runId: "run-9" } },
      connected: { recent: async () => ({ messages: [message] }) },
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

  it("answers nothing for two different codes, and takes the newest of equal ones", async () => {
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
    // Whatever order the mailbox lists them in, the newest is the one taken.
    const older = await connectedMail({ id: "m1", receivedAt: ago(20 * 1000) });
    const newer = await connectedMail({ id: "m2", receivedAt: ago(10 * 1000) });
    const same = inbox({
      emails: [],
      connectedMailCodes: true,
      connected: { recent: async () => ({ messages: [older, newer] }) },
    });
    expect(await same.deliver("run-1")).toBe(1);
    expect(same.effects.has(await claimOf(newer))).toBe(true);
    expect(same.effects.has(await claimOf(older))).toBe(false);
  });

  // The rule for which message may answer a request: one that arrived in the window after the
  // last answered code request for the site of the bot or of any run of the mailbox's owner,
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
    ["taken by another run", {}, { claimed: true }, "m1"],
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
            fromAddress: `news-${index}@example.test.elsewhere.test`,
            receivedAt: ago(5 * 1000 + index),
          }),
        ),
      },
      null,
    ],
    [
      "taken by another run through another connection to the same mailbox",
      {},
      { connections: [mailConnection({ id: "connection-2" })], claimed: true },
      "m1",
    ],
  ])(
    "takes the code from the right message when the newest is %s",
    async (_state, newest, { claimed, ...extra }, taken) => {
      publishKeys();
      vi.spyOn(getLogger(), "warn").mockImplementation(() => undefined);
      const messages = {
        m2: await connectedMail({ id: "m2", ...newest }),
        m1: await connectedMail({ id: "m1", receivedAt: ago(20 * 1000) }),
      };
      const { deliver, effects } = inbox({
        emails: [],
        connectedMailCodes: true,
        answeredAt: ago(30 * 1000),
        connected: { recent: async () => ({ messages: [messages.m2, messages.m1] }) },
        // Another run took the newest message's code.
        ...(claimed ? { effects: { [await claimOf(messages.m2)]: { runId: "run-9" } } } : {}),
        ...extra,
      });
      expect(await deliver("run-1")).toBe(taken ? 1 : 0);
      const takenNow: string[] = [];
      for (const [id, message] of Object.entries(messages))
        if (effects.get(await claimOf(message))?.runId === "run-1") takenNow.push(id);
      expect(takenNow).toEqual(taken ? [taken] : []);
    },
  );

  it("reads no mailbox once the owner turned the switch off during the attempt", async () => {
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
    const message = await connectedMail({ receivedAt: ago(45 * 1000) });
    const { deliver, reads } = inbox({
      emails: [],
      connectedMailCodes: true,
      answeredAt: ago(30 * 1000),
      connected: { recent: async () => ({ messages: [message] }) },
    });
    expect(await deliver("run-1")).toBe(0);
    // Mail that old is not fetched either: it would only use up what the look may read.
    expect(reads).toEqual([]);
  });

  it.each<[outcome: "success" | "failure", connected: () => Promise<{ recent: Recent } | Error>]>([
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

  // WHICH MAILBOXES a look reads: the owner's own connections in the run's Space that are
  // connected now and name the one account their provider is to read, asked afresh on every
  // look. Read through the real reader over a provider's fake, so what is asserted is what the
  // provider was asked, and as which account.
  describe("through the provider, of the owner's connections", () => {
    const audited = () => {
      const rows: Row[] = [];
      installAuditEventStore({
        auditEvent: { createMany: async ({ data }: { data: Row[] }) => rows.push(...data) },
        space: { findUnique: async () => ({ organizationId: "org-1", name: "Home" }) },
        user: { findUnique: async () => null },
        member: { findMany: async () => [] },
      } as never);
      return rows;
    };
    afterEach(() => installAuditEventStore(undefined));
    /** The owner's mailbox at the provider, holding the site's code, and a reader source. */
    const provider = async () => {
      publishKeys();
      vi.spyOn(getLogger(), "warn").mockImplementation(() => undefined);
      const client = new FakeComposioClient();
      const account = client.connect(bot.userId, "GMAIL");
      // A newer account of the owner's at the same provider, never connected in this Space.
      const unconnected = client.connect(bot.userId, "GMAIL");
      client.mailboxFor(bot.userId)!.address = "owner@example.net";
      const code = await connectedMail();
      client.receiveMail(bot.userId, new TextDecoder().decode(code.raw), new Date());
      const source = composioMailSource(new ConnectorRegistry([new ComposioConnector({ client })]));
      /** The accounts the provider was told to act as, for the owner. */
      const actedAs = () =>
        client.created
          .filter(({ userId }) => userId === bot.userId)
          .map(({ config }) => Object.values(config.connectedAccounts ?? {}).flat());
      return { client, account, unconnected, code, source, actedAs };
    };
    const legacy = (id: string, providerRef: string | null) =>
      mailConnection({ id, providerRef, displayName: id });

    it("reads the one that names its account, and none that lets the provider pick", async () => {
      const { client, account, unconnected, code, source, actedAs } = await provider();
      const rows = audited();
      const { deliver, effects } = inbox({
        emails: [],
        connectedMailCodes: true,
        source,
        connections: [
          legacy("connection-0", null),
          mailConnection({ providerRef: account }),
          legacy("connection-2", "gmail"),
          legacy("connection-3", " GMAIL "),
        ],
      });
      expect(await deliver("run-1")).toBe(1);
      expect(effects.has(await claimOf(code))).toBe(true);
      // Every call went out as that one account, never as whichever the provider would pick.
      expect(client.executions.length).toBeGreaterThan(0);
      expect(actedAs().length).toBeGreaterThan(0);
      for (const accounts of actedAs()) expect(accounts).toEqual([account]);
      expect(JSON.stringify(client.created)).not.toContain(unconnected);
      expect(rows.map((row) => row.targetId)).toEqual(["connection-1"]);
    });

    it("reads nothing, and leaves the card, when none names its account", async () => {
      const { client, source, actedAs } = await provider();
      const rows = audited();
      const { deliver, answerRunInput } = inbox({
        emails: [],
        connectedMailCodes: true,
        source,
        connections: [legacy("connection-0", null), legacy("connection-2", "gmail")],
      });
      expect(await deliver("run-1")).toBe(0);
      expect(answerRunInput).not.toHaveBeenCalled();
      expect(client.executions).toEqual([]);
      expect(actedAs()).toEqual([]);
      expect(rows).toEqual([]);
    });

    it.each<
      [change: string, apply: (world: Awaited<ReturnType<typeof provider>>, row: Row) => void]
    >([
      ["revoked", (_world, row) => Object.assign(row, { status: "revoked" })],
      ["waiting to be connected again", (_world, row) => Object.assign(row, { status: "pending" })],
      ["removed", (_world, row) => Object.assign(row, { gone: true })],
      ["expired at the provider", ({ client, account }) => client.setStatus(account, "EXPIRED")],
    ])("reads no mailbox whose connection was %s since the last look", async (_change, apply) => {
      const world = await provider();
      const row = mailConnection({ providerRef: world.account });
      // The first look finds a card for another page, so it takes nothing; it did read.
      const connections = [row];
      const { deliver, prisma, answerRunInput } = inbox({
        emails: [],
        connectedMailCodes: true,
        source: world.source,
        connections,
        cards: { "run-1": codeCard("https://login.elsewhere.test") },
      });
      expect(await deliver("run-1")).toBe(0);
      const before = world.client.executions.length;
      expect(before).toBeGreaterThan(0);
      apply(world, row);
      prisma.connection.findMany.mockImplementation(async () =>
        connections.filter((connection) => !connection.gone),
      );
      expect(await deliver("run-1")).toBe(0);
      expect(answerRunInput).not.toHaveBeenCalled();
      // Nothing more was read from the mailbox.
      expect(world.client.executions.length).toBe(before);
    });

    it("asks only for the owner's own connections in the run's Space", async () => {
      const { source } = await provider();
      const { deliver, prisma } = inbox({ emails: [], connectedMailCodes: true, source });
      await deliver("run-1");
      expect(prisma.connection.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: "user-1", spaceId: "space-1" } }),
      );
    });
  });

  // BOUNDS: a look reads at most CONNECTED_MAIL_MAX_BYTES of mail in all, and only mail that
  // may be the site's is read or counted: what the mailbox lists from another sender, before
  // the request's window, or from before the last answer costs nothing, whatever its size. A
  // message that may be the site's and is past what the look may still read is not fetched,
  // and the look gives no code: it may be the newest from the site.
  const MIB = 1024 * 1024;
  const sized = (id: string, from: string | null, size: number | null, extra: Partial<Held> = {}) =>
    ({ id, raw: new Uint8Array(64), receivedAt: ago(5 * 1000), from, size, ...extra }) as Held;
  const SITE = "news@example.test";
  const ELSEWHERE = "news@example.test.elsewhere.test";
  it.each<[others: string, fills: boolean, mail: () => Held[], fetched?: string[]]>([
    ["no other mail", true, () => []],
    [
      "a huge message the provider matched from another sender",
      true,
      () => [sized("big", ELSEWHERE, 30 * MIB)],
    ],
    [
      "more mail from other senders than the look may read in all",
      true,
      () => Array.from({ length: 4 }, (_, index) => sized(`big-${index}`, ELSEWHERE, MIB)),
    ],
    [
      "a huge message from the site that came before the request's window",
      true,
      () => [sized("old", SITE, 30 * MIB, { receivedAt: ago(7 * 60 * 1000) })],
    ],
    [
      "other mail from the site within what the look may read",
      true,
      () => [sized("small", SITE, 1024)],
      ["small", "m1"],
    ],
    [
      "a message from the site larger than the look may read",
      false,
      () => [sized("big", SITE, 3 * MIB)],
    ],
    [
      "mail from the site that passes what the look may read together",
      false,
      () => [
        sized("half-1", SITE, MIB, { raw: new Uint8Array(MIB) }),
        sized("half-2", SITE, MIB + 1, { raw: new Uint8Array(MIB + 1) }),
      ],
      ["half-1"],
    ],
    [
      "a huge message whose sender the provider does not tell",
      false,
      () => [sized("unknown", null, 30 * MIB)],
    ],
    [
      "a message from the site larger than its provider said",
      false,
      () => [sized("grown", SITE, 1024, { raw: new Uint8Array(CONNECTED_MAIL_MAX_BYTES + 1) })],
      ["grown"],
    ],
    [
      "a message from the site whose size the provider does not tell",
      false,
      () => [sized("unsized", SITE, null)],
    ],
    [
      "a message from another sender whose size the provider does not tell",
      true,
      () => [sized("unsized", ELSEWHERE, null)],
    ],
  ])(
    "beside %s in the mailbox, takes the site's code: %s",
    async (_others, fills, mail, fetched) => {
      publishKeys();
      vi.spyOn(getLogger(), "warn").mockImplementation(() => undefined);
      const code = await connectedMail();
      const { deliver, effects, reads } = inbox({
        emails: [],
        connectedMailCodes: true,
        // The other mail is the newer, as the provider lists it; the site's code comes after.
        connected: {
          recent: async (_context, query) =>
            query.page ? { messages: [code] } : { messages: mail(), next: "1" },
        },
      });
      expect(await deliver("run-1")).toBe(fills ? 1 : 0);
      expect(effects.has(await claimOf(code))).toBe(fills);
      // Only what may be the site's and fits is ever fetched.
      expect(reads).toEqual(fetched ?? (fills ? ["m1"] : []));
    },
  );

  it("gives no code once a reader handed over more than the look may read", async () => {
    publishKeys();
    vi.spyOn(getLogger(), "warn").mockImplementation(() => undefined);
    const code = await connectedMail();
    // A long welcome from the site, which names no code: its provider says it is small, and its
    // reader hands it over whole. The look holds what comes back to its limit itself.
    const line = "Thanks for joining us.\r\n";
    const welcome = await connectedMail({
      id: "past",
      text: line.repeat(Math.ceil(CONNECTED_MAIL_MAX_BYTES / line.length)),
    });
    const past = { ...welcome, size: 1024, unchecked: true };
    const { deliver, effects, reads } = inbox({
      emails: [],
      connectedMailCodes: true,
      connected: { recent: async () => ({ messages: [code, past] }) },
    });
    expect(await deliver("run-1")).toBe(0);
    expect(effects.has(await claimOf(code))).toBe(false);
    expect(reads).toEqual(["m1", "past"]);
  });

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
