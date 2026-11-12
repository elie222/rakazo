import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { promises as dnsPromises } from "node:dns";
import type { AnswerRunInput } from "@rakazo/db";
import { answerRunInput, createDb, runAsSystem, runAsTenant, runCodeKind } from "@rakazo/db";
import { dkimSign } from "mailauth";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  answerCodeCardsFromInbox,
  claimEmailedCode,
  EMAILED_CODE_WINDOW_MS,
  EmailedCodeTaken,
  emailedCodeWindow,
  findEmailedCode,
  notePageForEmailedCode,
  takeEmailedCode,
} from "./emailed-code.js";
import { createRunSecretWriter, holdEmailedCode, SecretRequestNotOpen } from "./run-secret.js";
import { EncryptedSecretStore } from "./secrets.js";

const postgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

postgres("emailed code claims (PostgreSQL)", () => {
  const { prisma, pool } = createDb(process.env.DATABASE_URL ?? "");
  const id = `emailed-code-${randomUUID()}`;
  const spaceId = `${id}-space`;
  const userId = `${id}-user`;
  const organizationId = `${id}-org`;
  const system = <T>(fn: () => Promise<T>) => runAsSystem("test fixture", fn);
  /** Someone who is not the bot's owner. */
  const stranger = `${id}-stranger`;
  const origin = "https://login.example.test";
  let botId = "";
  let threadId = "";
  let runs: string[] = [];
  /** The run that won the race in the first case. */
  let winner = "";

  beforeAll(async () => {
    await system(async () => {
      await prisma.user.createMany({
        data: [
          { id: userId, name: "Code tester", email: `${id}@rakazo.test` },
          { id: stranger, name: "Stranger", email: `${stranger}@rakazo.test` },
        ],
      });
      await prisma.organization.create({
        data: { id: organizationId, name: "Code tests", slug: id, createdAt: new Date() },
      });
      await prisma.space.create({ data: { id: spaceId, organizationId, name: "Code tests" } });
      const bot = await prisma.bot.create({
        data: {
          spaceId,
          userId,
          name: "Signer",
          color: "ink",
          thread: { create: { spaceId, userId } },
        },
        include: { thread: true },
      });
      botId = bot.id;
      threadId = bot.thread!.id;
    });
    runs = [await newRun("running"), await newRun("running")];
  });

  type Place = { spaceId: string; userId: string; botId: string; threadId: string };
  const home = (): Place => ({ spaceId, userId, botId, threadId });

  async function newRun(status: "running" | "waiting_input" | "cancelled", place: Place = home()) {
    return system(async () => {
      const task = await prisma.task.create({
        data: { ...place, prompt: "Sign in", status: "running" },
      });
      const run = await prisma.run.create({
        data: { ...place, taskId: task.id, status, trigger: "user_message" },
        select: { id: true },
      });
      return run.id;
    });
  }

  /** Another Space with a bot of `owner`'s: the tester's own unless given. */
  async function otherSpace(name: string, owner = userId): Promise<Place> {
    return system(async () => {
      const space = await prisma.space.create({
        data: { id: `${id}-${name}`, organizationId, name },
      });
      const bot = await prisma.bot.create({
        data: {
          spaceId: space.id,
          userId: owner,
          name,
          color: "ink",
          thread: { create: { spaceId: space.id, userId: owner } },
        },
        include: { thread: true },
      });
      return { spaceId: space.id, userId: owner, botId: bot.id, threadId: bot.thread!.id };
    });
  }

  /** A run's code request for a page of the site, recorded as request_secret records it. */
  const ask = (runId: string, place: Place = home(), page = origin, askedAt = new Date()) =>
    system(() =>
      prisma.externalEffect.create({
        data: {
          runId,
          spaceId: place.spaceId,
          kind: "request_secret",
          status: "intended",
          idempotencyKey: `${runId}:request:${randomUUID()}`,
          request: { label: "Code", purpose: "otp", oneTimeCode: { origin: page } },
          createdAt: askedAt,
        },
        select: { id: true },
      }),
    );
  const settle = (requestId: string, status: string) =>
    system(() => prisma.externalEffect.update({ where: { id: requestId }, data: { status } }));
  /** Leave no mail and no request, open or answered, in any of this suite's Spaces. */
  const forgetRequests = () =>
    system(async () => {
      await prisma.botEmailMessage.deleteMany({ where: { botId } });
      await prisma.externalEffect.deleteMany({
        where: { kind: "request_secret", run: { space: { organizationId } } },
      });
    });

  afterAll(async () => {
    try {
      // The organization cascades to the space, bot, runs, their effects and the inbox.
      await system(async () => {
        await prisma.organization.deleteMany({ where: { id: organizationId } });
        await prisma.user.deleteMany({ where: { id: { in: [userId, stranger] } } });
      });
      await prisma.$disconnect();
    } finally {
      await pool.end();
    }
  });

  async function receive(
    code: string,
    from = "no-reply@example.test",
    options: { mailingList?: false; autoReplyOrBulk?: false } = {
      mailingList: false,
      autoReplyOrBulk: false,
    },
  ) {
    return system(() =>
      prisma.botEmailMessage.create({
        data: {
          spaceId,
          botId,
          key: `<${randomUUID()}@example.test>`,
          fromAddress: from,
          fromName: "Example",
          verified: true,
          ...options,
          to: ["signer@bots.test"],
          cc: [],
          subject: "Your sign-in code",
          text: `Your verification code is ${code}.`,
        },
        select: { id: true, key: true },
      }),
    );
  }

  /** Claim a message's code as a run keeping it does, in its own transaction: false when taken. */
  const claimMessage = (
    runId: string,
    message: { key: string; id?: string },
    site = "example.test",
  ) =>
    system(() =>
      prisma.$transaction((tx) =>
        claimEmailedCode(tx, {
          runId,
          requestId: `request-of-${runId}`,
          spaceId,
          botId,
          userId,
          site,
          key: message.key,
          receivedAt: new Date(),
          ...(message.id ? { emailId: message.id } : {}),
        }),
      ),
    ).then(
      () => true,
      (error) => {
        if (error instanceof EmailedCodeTaken) return false;
        throw error;
      },
    );
  const claimFor = (runId: string, email: { id: string; key: string }) =>
    claimMessage(runId, email);

  const lookup = (runId: string) => ({
    botId,
    spaceId,
    runId,
    requestId: `request-of-${runId}`,
    userId,
    origin,
    // The run started a minute ago and asks now.
    window: emailedCodeWindow(new Date(), new Date(Date.now() - 60_000)),
    botEmailDomain: "bots.test",
    sources: { inbox: true, connected: undefined },
  });

  /** The runs that took the email's code: one claim per run and site, one per message. */
  const takers = (emailId: string) =>
    system(async () =>
      (
        await prisma.externalEffect.findMany({
          where: {
            kind: "emailed_code",
            idempotencyKey: { startsWith: "emailed-code:message:" },
            request: { path: ["emailId"], equals: emailId },
          },
          select: { runId: true },
        })
      ).map((effect) => effect.runId),
    );
  const heldCodes = (runId: string) =>
    system(() => prisma.secret.count({ where: { userId, kind: runCodeKind(runId) } }));

  const messageClaim = (key: string) =>
    `emailed-code:message:${createHash("sha256").update(key).digest("base64url")}`;

  it("gives one message to one run across mailboxes, and a site's code once in all", async () => {
    const runId = await newRun("running");
    const other = await newRun("running");
    // One message, read by one run from the bot's inbox and by the other from the owner's
    // connected mailbox: the same key, so one of them gets it.
    const message = await receive("884200");
    const claims = await Promise.all([
      claimMessage(runId, message),
      claimMessage(other, { key: message.key }),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const taker = claims[0] ? runId : other;
    const loser = claims[0] ? other : runId;
    // Neither another connected message nor the bot's own inbox gives the taker a second code
    // for the site in this run; a code for another site is still free.
    expect(await claimMessage(taker, { key: "dkim:message-2" })).toBe(false);
    expect(await claimFor(taker, await receive("884201"))).toBe(false);
    expect(await claimMessage(taker, { key: "dkim:message-3" }, "other.example")).toBe(true);
    // The loser took no code for the site, so the inbox's is still free for it.
    expect(await claimFor(loser, await receive("884202"))).toBe(true);
    // The refused claims wrote nothing but the taken ones.
    const taken = await system(() =>
      prisma.externalEffect.findMany({
        where: { runId: { in: [runId, other] }, kind: "emailed_code", status: "taken" },
        select: { runId: true, idempotencyKey: true },
        orderBy: { idempotencyKey: "asc" },
      }),
    );
    const keys = taken.map((effect) => effect.idempotencyKey);
    expect(keys.filter((key) => key.startsWith("emailed-code:message:"))).toHaveLength(3);
    expect(keys).toEqual(
      expect.arrayContaining([
        messageClaim(message.key),
        messageClaim("dkim:message-3"),
        `emailed-code:run:${taker}:example.test`,
        `emailed-code:run:${taker}:other.example`,
        `emailed-code:run:${loser}:example.test`,
      ]),
    );
    expect(keys).toHaveLength(6);
    // This case's inbox mail would make the site's code ambiguous for the cases after it.
    await system(() => prisma.botEmailMessage.deleteMany({ where: { botId } }));
  });

  // The rule: mail does not say which sign-in it is for, so a run takes its code only while
  // its own is the one open code request the mail could be for, among the bot's runs and its
  // owner's runs in every Space. Decided in the transaction that takes the code.
  it.each<
    [
      others: string,
      fills: boolean,
      other: () => Promise<{
        place?: Place;
        page?: string;
        status?: string;
        asks?: boolean;
        askedAt?: Date;
      }>,
    ]
  >([
    ["no other request", true, async () => ({ asks: false })],
    ["another run of the bot asking for the site", false, async () => ({})],
    [
      "a run of another of the owner's bots, in another Space, asking for the site",
      false,
      async () => ({ place: await otherSpace("mine") }),
    ],
    [
      "another run asking for another host of the site",
      false,
      async () => ({ page: "https://app.example.test" }),
    ],
    ["another run asking for another site", true, async () => ({ page: "https://bank.test" })],
    [
      "someone else's run of the owner's bot asking for the site",
      false,
      async () => ({ place: { ...home(), userId: stranger } }),
    ],
    [
      "another owner's run of their own bot asking for the site",
      true,
      async () => ({ place: await otherSpace("theirs", stranger) }),
    ],
    [
      "someone else's run of another of the owner's bots asking for the site",
      true,
      async () => ({ place: { ...(await otherSpace("lent")), userId: stranger } }),
    ],
    ["a run whose request for the site was answered", true, async () => ({ status: "approved" })],
    // A call allowed without asking holds its request while it looks: that one is still open.
    [
      "a run whose call holds its request for the site while it works on it",
      false,
      async () => ({ status: "executing" }),
    ],
    ["a cancelled run that had asked for the site", true, async () => ({ status: "cancelled" })],
    // A request blocks only mail it could take itself: past its window it keeps no one from a code.
    [
      "a run whose card for the site has been open since long before the mail came",
      true,
      async () => ({ askedAt: new Date(Date.now() - EMAILED_CODE_WINDOW_MS - 60_000) }),
    ],
    [
      "a run that asked for the site's code a little under five minutes before the mail came",
      false,
      async () => ({ askedAt: new Date(Date.now() - EMAILED_CODE_WINDOW_MS + 30_000) }),
    ],
  ])("with %s, a run in its own Space takes the site's code: %s", async (_others, fills, other) => {
    const runId = await newRun("running");
    const mine = await ask(runId);
    const { place = home(), page, status, asks = true, askedAt } = await other();
    if (asks) {
      const theirs = await newRun(status === "cancelled" ? "cancelled" : "waiting_input", place);
      const request = await ask(theirs, place, page, askedAt);
      if (status === "approved" || status === "executing") await settle(request.id, status);
    }
    // Mail no older than an answer is never used: this one comes after it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const email = await receive("551204");
    const secretStore = new EncryptedSecretStore("test-only-encryption-key");
    // As the run's job does: in the run's own Space, where other Spaces' runs are not visible.
    const kept = await runAsTenant({ spaceId, userId }, () =>
      holdEmailedCode(prisma, secretStore, {
        ...lookup(runId),
        scope: { userId, spaceId, botId },
        request: { id: mine.id, from: "intended", result: { ok: true } },
        hide: () => undefined,
      }),
    );
    expect(Boolean(kept)).toBe(fills);
    expect(await takers(email.id)).toEqual(fills ? [runId] : []);
    expect(await heldCodes(runId)).toBe(fills ? 1 : 0);
    await forgetRequests();
  });

  // The owner's mailbox is one, whichever Space reads it: what is known of an email's code is
  // known in every Space. Each run looks as its job does, inside its own Space.
  const dkim = (() => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const der = publicKey.export({ type: "spki", format: "der" }).toString("base64");
    return {
      privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      record: `v=DKIM1; k=rsa; p=${der}`,
    };
  })();
  type Held = { id: string; raw: Uint8Array; receivedAt: Date };
  /** A message the site sent to an owner's own mailbox, signed by the site. */
  async function sent(code: string, to = "owner@example.net"): Promise<Held> {
    const id = randomUUID();
    const raw = [
      "From: Example <no-reply@example.test>",
      `To: ${to}`,
      "Subject: Your sign-in code",
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${id}@example.test>`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      `Your verification code is ${code}.`,
      "",
    ].join("\r\n");
    const { signatures } = await dkimSign(raw, {
      signatureData: [
        { signingDomain: "example.test", selector: "s1", privateKey: dkim.privateKey },
      ],
    });
    return { id, raw: new TextEncoder().encode(signatures + raw), receivedAt: new Date() };
  }
  /** A mailbox as each connection to it reads it; `read` names the messages it handed over. */
  const mailboxOf = (address: string, messages: Held[]) => {
    const read: string[] = [];
    const source = {
      readerFor: () => ({
        mailbox: async () => address,
        recent: async () => ({
          messages: messages.map(({ id, raw, receivedAt }) => ({
            id,
            from: "no-reply@example.test",
            size: raw.byteLength,
            receivedAt,
          })),
        }),
        read: async (_context: unknown, id: string) => {
          read.push(id);
          return messages.find((message) => message.id === id)!.raw;
        },
      }),
    };
    return { source, read };
  };
  /** The owner connects a mailbox in a Space and lets its bot read it for codes. */
  const connectMail = (place: Place) =>
    system(async () => {
      await prisma.connection.create({
        data: {
          spaceId: place.spaceId,
          userId: place.userId,
          provider: "GMAIL",
          displayName: "Mail",
          status: "connected",
          providerRef: `ca_${randomUUID()}`,
        },
      });
      await prisma.bot.update({ where: { id: place.botId }, data: { connectedMailCodes: true } });
    });
  /** A run of `place` asks for the site's code and looks in the mailbox, inside its Space. */
  async function asks(place: Place, source: ReturnType<typeof mailboxOf>["source"]) {
    const runId = await newRun("running", place);
    const request = await ask(runId, place);
    const secretStore = new EncryptedSecretStore("test-only-encryption-key");
    const kept = await runAsTenant(place, () =>
      holdEmailedCode(prisma, secretStore, {
        ...lookup(runId),
        ...place,
        sources: { inbox: false, connected: source },
        scope: place,
        request: { id: request.id, from: "intended", result: { ok: true } },
        hide: () => undefined,
      }),
    );
    // Its request is done with, one way or the other, before the next one asks.
    await settle(request.id, kept ? "completed" : "denied");
    return { runId, code: kept?.code };
  }
  const claimsOf = (runIds: string[]) =>
    system(() =>
      prisma.externalEffect.count({
        where: {
          runId: { in: runIds },
          kind: "emailed_code",
          idempotencyKey: { startsWith: "emailed-code:message:" },
        },
      }),
    );
  afterEach(() => {
    vi.restoreAllMocks();
  });
  const publishKey = () =>
    vi.spyOn(dnsPromises, "resolve").mockImplementation((async (name: string) => {
      if (name.startsWith("s1._domainkey.")) return [[dkim.record]];
      throw Object.assign(new Error(`queryTxt ENOTFOUND ${name}`), { code: "ENOTFOUND" });
    }) as never);

  it("takes a message's code once across its owner's Spaces, and no other owner's", async () => {
    publishKey();
    const [here, there, theirs] = [
      home(),
      await otherSpace("second"),
      await otherSpace("else", stranger),
    ];
    for (const place of [here, there, theirs]) await connectMail(place);
    const message = await sent("773102");
    const owners = mailboxOf("owner@example.net", [message]);
    // A run of one Space takes the code.
    const first = await asks(here, owners.source);
    expect(first.code).toBe("773102");
    // A run of another of the owner's bots, in another Space, and a second run of the same
    // bot then find nothing to take: the card opens, and the message keeps its one claim.
    const elsewhere = await asks(there, owners.source);
    const again = await asks(here, owners.source);
    expect([elsewhere.code, again.code]).toEqual([undefined, undefined]);
    expect(await claimsOf([first.runId, elsewhere.runId, again.runId])).toBe(1);
    expect(await heldCodes(elsewhere.runId)).toBe(0);
    // Another owner's own mail for the same site is theirs to take, whatever happened here.
    const strangers = mailboxOf("stranger@example.net", [
      await sent("204417", "stranger@example.net"),
    ]);
    expect((await asks(theirs, strangers.source)).code).toBe("204417");
    await forgetRequests();
  });

  it("takes no mail from before the owner answered the site's card in another Space", async () => {
    publishKey();
    const [here, there] = [home(), await otherSpace("answers")];
    await connectMail(here);
    const old = await sent("318840");
    // The owner types that code into the card of a run in their other Space.
    const waiting = await newRun("waiting_input", there);
    const request = await ask(waiting, there);
    const card = await system(() =>
      prisma.message.create({
        data: {
          threadId: there.threadId,
          seq: 1,
          role: "bot",
          botId: there.botId,
          runId: waiting,
          blocks: [
            {
              kind: "ask",
              text: "Code for login.example.test",
              input: "secret",
              oneTimeCode: { origin },
              purpose: "otp",
              status: "pending",
            },
          ],
        },
        select: { id: true },
      }),
    );
    const writer = createRunSecretWriter(new EncryptedSecretStore("test-only-encryption-key"));
    const typed = await runAsTenant(there, () =>
      answerRunInput(
        prisma,
        {
          spaceId: there.spaceId,
          threadId: there.threadId,
          runId: waiting,
          messageId: card.id,
          answeredByUserId: userId,
          answer: "318840",
        },
        undefined,
        writer,
      ),
    );
    expect(typed).toBe(true);
    expect(
      await system(() => prisma.externalEffect.findUniqueOrThrow({ where: { id: request.id } })),
    ).toMatchObject({ status: "approved" });
    // A run in this Space reads the same mailbox: the older mail is not fetched, let alone taken.
    const before = mailboxOf("owner@example.net", [old]);
    expect((await asks(here, before.source)).code).toBeUndefined();
    expect(before.read).toEqual([]);
    // Mail that comes after that answer is this request's.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const after = mailboxOf("owner@example.net", [old, await sent("905512")]);
    expect((await asks(here, after.source)).code).toBe("905512");
    await forgetRequests();
  });

  it("keeps nothing when the site's card is answered while the code is being kept", async () => {
    // The look found the email unused; the owner then answers a card for the site in another
    // Space before the code is claimed. The claim sees it, in every Space, and takes nothing.
    const there = await otherSpace("meanwhile");
    const theirs = await ask(await newRun("waiting_input", there), there);
    const runId = await newRun("running");
    const mine = await ask(runId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const email = await receive("447281");
    const secretStore = new EncryptedSecretStore("test-only-encryption-key");
    const put = secretStore.put.bind(secretStore);
    vi.spyOn(secretStore, "put").mockImplementationOnce(async (...args) => {
      await settle(theirs.id, "approved");
      return put(...args);
    });
    const kept = await runAsTenant({ spaceId, userId }, () =>
      holdEmailedCode(prisma, secretStore, {
        ...lookup(runId),
        scope: { userId, spaceId, botId },
        request: { id: mine.id, from: "intended", result: { ok: true } },
        hide: () => undefined,
      }),
    );
    expect(kept).toBeUndefined();
    expect(await takers(email.id)).toEqual([]);
    expect(await heldCodes(runId)).toBe(0);
    await forgetRequests();
  });

  it("takes the code for a request its own call holds, which is not an answer", async () => {
    // A call allowed without asking holds its request as executing before it looks: that is the
    // request asking, not one answered since the email came.
    const runId = await newRun("running");
    const mine = await ask(runId);
    const email = await receive("640271");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await settle(mine.id, "executing");
    const secretStore = new EncryptedSecretStore("test-only-encryption-key");
    const kept = await runAsTenant({ spaceId, userId }, () =>
      holdEmailedCode(prisma, secretStore, {
        ...lookup(runId),
        scope: { userId, spaceId, botId },
        request: { id: mine.id, from: "executing", result: { ok: true } },
        hide: () => undefined,
      }),
    );
    expect(kept).toMatchObject({ code: "640271" });
    expect(await takers(email.id)).toEqual([runId]);
    await forgetRequests();
  });

  it("gives the code to neither of two runs that ask for the site at the same moment", async () => {
    const [runA, runB] = [await newRun("running"), await newRun("running")];
    // Both requests are recorded, as the call records its request before it looks.
    const [requestA, requestB] = [await ask(runA), await ask(runB)];
    const email = await receive("660319");
    const secretStore = new EncryptedSecretStore("test-only-encryption-key");
    const hold = (runId: string, requestId: string) =>
      system(() =>
        holdEmailedCode(prisma, secretStore, {
          ...lookup(runId),
          scope: { userId, spaceId, botId },
          request: { id: requestId, from: "intended", result: { ok: true } },
          hide: () => undefined,
        }),
      );
    expect(await Promise.all([hold(runA, requestA.id), hold(runB, requestB.id)])).toEqual([
      undefined,
      undefined,
    ]);
    expect(await takers(email.id)).toEqual([]);
    // One is answered by its owner: the other still takes no mail that came before that answer.
    await settle(requestA.id, "approved");
    expect(await hold(runB, requestB.id)).toBeUndefined();
    // Mail that comes after it is the one open request's.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const next = await receive("660320");
    expect(await hold(runB, requestB.id)).toMatchObject({ code: "660320" });
    expect(await takers(next.id)).toEqual([runB]);
    await forgetRequests();
  });

  it.each([
    ["it came through a list", { autoReplyOrBulk: false as const }],
    ["it was an auto-reply or bulk mail", { mailingList: false as const }],
    ["either", {}],
  ])("never takes mail saved before it was known whether %s", async (_flag, known) => {
    // As the previous release saves mail while it still runs, and as every older row reads.
    const runId = runs[0]!;
    await receive("482913", "no-reply@example.test", known);
    expect(await system(() => findEmailedCode(prisma, lookup(runId)))).toBeUndefined();
    await receive("482913");
    expect(await system(() => findEmailedCode(prisma, lookup(runId)))).toMatchObject({
      code: "482913",
    });
    await system(() => prisma.botEmailMessage.deleteMany({ where: { botId } }));
  });

  it("finds the site's email under sixty newer signed emails from other senders", async () => {
    const email = await receive("317244");
    for (let index = 0; index < 60; index += 1)
      await receive(String(100_000 + index), `news-${index}@elsewhere.test`);
    const found = await system(() => findEmailedCode(prisma, lookup(runs[0]!)));
    expect(found).toMatchObject({ code: "317244", emailId: email.id });
    await system(() => prisma.botEmailMessage.deleteMany({ where: { botId } }));
  });

  it("gives an email's code to one of two runs that claim it at once", async () => {
    const email = await receive("482913");
    const [runA, runB] = runs as [string, string];
    // Both looked before either claimed, as a request and arriving mail can.
    const found = await system(() =>
      Promise.all([findEmailedCode(prisma, lookup(runA)), findEmailedCode(prisma, lookup(runB))]),
    );
    expect(found).toMatchObject([{ emailId: email.id }, { emailId: email.id }]);
    const claimed = await Promise.all([runA, runB].map((runId) => claimFor(runId, email)));
    expect(claimed.filter(Boolean)).toHaveLength(1);
    winner = claimed[0] ? runA : runB;
    // Taken: neither run finds it again.
    for (const runId of [runA, runB])
      expect(await system(() => findEmailedCode(prisma, lookup(runId)))).toBeUndefined();
    const effects = await system(() =>
      prisma.externalEffect.findMany({
        where: {
          idempotencyKey: { startsWith: "emailed-code:message:" },
          request: { path: ["emailId"], equals: email.id },
        },
        select: { runId: true, kind: true, status: true },
      }),
    );
    expect(effects).toEqual([{ runId: winner, kind: "emailed_code", status: "taken" }]);
  });

  it("takes one emailed code per site in a run, leaving the next email for another", async () => {
    const email = await receive("731905");
    const claim = (runId: string) => claimFor(runId, email);
    // The run that won above already took this site's code.
    expect(await claim(winner)).toBe(false);
    expect(
      await system(() =>
        takeEmailedCode(prisma, lookup(winner), (_found, keep) => prisma.$transaction(keep)),
      ),
    ).toBeUndefined();
    // The refused claim wrote nothing, so the email is still free for the other run.
    const loser = runs.find((runId) => runId !== winner)!;
    expect(await claim(loser)).toBe(true);
  });

  it("leaves the email's code, and its request open, when keeping it fails", async () => {
    const runId = await newRun("running");
    const email = await receive("605118");
    const request = await system(() =>
      prisma.externalEffect.create({
        data: {
          runId,
          spaceId,
          kind: "request_secret",
          status: "intended",
          idempotencyKey: `${runId}:request`,
          request: {},
        },
        select: { id: true },
      }),
    );
    const requestNow = () =>
      system(() =>
        prisma.externalEffect.findUniqueOrThrow({
          where: { id: request.id },
          select: { status: true, result: true },
        }),
      );
    const settle = (status: string) =>
      system(() => prisma.externalEffect.update({ where: { id: request.id }, data: { status } }));
    const secretStore = new EncryptedSecretStore("test-only-encryption-key");
    const scope = { userId, spaceId, botId };
    const answer = { note: "The code from the email the site sent was entered." };
    /** What the attempt was told to hide, and when: before the code's transaction commits. */
    const hidden: string[] = [];
    const hold = (over: { scope?: typeof scope } = {}) =>
      system(() =>
        holdEmailedCode(prisma, secretStore, {
          ...lookup(runId),
          scope,
          request: { id: request.id, from: "intended", result: answer },
          hide: (code) => hidden.push(code),
          ...over,
        }),
      );

    // The code could not be sealed.
    vi.spyOn(secretStore, "put").mockRejectedValueOnce(new Error("store unavailable"));
    await expect(hold()).rejects.toThrow("store unavailable");
    expect(await takers(email.id)).toEqual([]);
    // Sealed, but its row could not be saved.
    await expect(hold({ scope: { ...scope, userId: `${id}-nobody` } })).rejects.toThrow();
    expect(await takers(email.id)).toEqual([]);
    // The request is settled (the run was cancelled) after the lookup, while the code is sealed:
    // nothing is kept or claimed.
    const put = secretStore.put.bind(secretStore);
    vi.spyOn(secretStore, "put").mockImplementationOnce(async (...args) => {
      await settle("denied");
      return put(...args);
    });
    await expect(hold()).rejects.toThrow(SecretRequestNotOpen);
    expect(await takers(email.id)).toEqual([]);
    expect(await heldCodes(runId)).toBe(0);
    expect(await requestNow()).toMatchObject({ status: "denied", result: null });
    await settle("intended");

    // A code is hidden from the moment it is claimed, also when keeping it then fails.
    expect(hidden).toEqual(["605118", "605118"]);
    // The next try takes it, once, and answers the request with it in the same transaction.
    expect(await hold()).toMatchObject({ code: "605118", fromEmail: email.id });
    expect(await takers(email.id)).toEqual([runId]);
    expect(await heldCodes(runId)).toBe(1);
    expect(await requestNow()).toEqual({ status: "completed", result: answer });
    expect(await hold()).toBeUndefined();
  });

  it("leaves an email's code for the next look when answering the card with it fails", async () => {
    const runId = await newRun("waiting_input");
    const request = await system(() =>
      prisma.externalEffect.create({
        data: {
          runId,
          spaceId,
          kind: "request_secret",
          status: "intended",
          idempotencyKey: `${runId}:request`,
          request: {},
        },
        select: { id: true },
      }),
    );
    await system(() =>
      notePageForEmailedCode(prisma, { runId, spaceId, requestId: request.id, origin }),
    );
    const card = await system(() =>
      prisma.message.create({
        data: {
          threadId,
          seq: 1,
          role: "bot",
          botId,
          runId,
          blocks: [
            {
              kind: "ask",
              text: "Code for login.example.test",
              input: "secret",
              oneTimeCode: { origin },
              purpose: "otp",
              status: "pending",
            },
          ],
        },
        select: { id: true },
      }),
    );
    const email = await receive("905117");
    const secretStore = new EncryptedSecretStore("test-only-encryption-key");
    const writer = createRunSecretWriter(secretStore);
    const deps = {
      prisma,
      events: {
        answerRunInput: (input: AnswerRunInput) => answerRunInput(prisma, input, undefined, writer),
      },
      jobs: { enqueue: vi.fn(async () => undefined) },
      botEmailDomain: "bots.test",
    };
    const answer = () => system(() => answerCodeCardsFromInbox(deps, { id: botId, userId }, runId));

    // The code could not be sealed, so the card still waits.
    vi.spyOn(secretStore, "put").mockRejectedValueOnce(new Error("store unavailable"));
    expect(await answer()).toBe(0);
    expect(await takers(email.id)).toEqual([]);
    expect(await heldCodes(runId)).toBe(0);

    // The next look answers it with the same email.
    expect(await answer()).toBe(1);
    expect(await takers(email.id)).toEqual([runId]);
    expect(await heldCodes(runId)).toBe(1);
    expect(
      await system(() => prisma.message.findUniqueOrThrow({ where: { id: card.id } })),
    ).toMatchObject({ blocks: [{ status: "answered" }] });
  });
});
