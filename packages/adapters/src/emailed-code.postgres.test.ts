import { createHash, randomUUID } from "node:crypto";
import type { AnswerRunInput } from "@rakazo/db";
import { answerRunInput, createDb, runAsSystem, runCodeKind } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  answerCodeCardsFromInbox,
  claimConnectedMailCode,
  claimEmailedCode,
  EmailedCodeTaken,
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
  const origin = "https://login.example.test";
  let botId = "";
  let threadId = "";
  let runs: string[] = [];
  /** The run that won the race in the first case. */
  let winner = "";

  beforeAll(async () => {
    await system(async () => {
      await prisma.user.create({
        data: { id: userId, name: "Code tester", email: `${id}@rakazo.test` },
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

  async function newRun(status: "running" | "waiting_input") {
    return system(async () => {
      const task = await prisma.task.create({
        data: { spaceId, userId, botId, threadId, prompt: "Sign in", status: "running" },
      });
      const run = await prisma.run.create({
        data: {
          spaceId,
          userId,
          botId,
          threadId,
          taskId: task.id,
          status,
          trigger: "user_message",
        },
        select: { id: true },
      });
      return run.id;
    });
  }

  afterAll(async () => {
    try {
      // The organization cascades to the space, bot, runs, their effects and the inbox.
      await system(async () => {
        await prisma.organization.deleteMany({ where: { id: organizationId } });
        await prisma.user.deleteMany({ where: { id: userId } });
      });
      await prisma.$disconnect();
    } finally {
      await pool.end();
    }
  });

  async function receive(
    code: string,
    from = "no-reply@example.test",
    options: { mailingList?: false } = { mailingList: false },
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

  /** Claim as a run keeping the code does, in its own transaction: false when taken. */
  const claimFor = (runId: string, email: { id: string; key: string }) =>
    system(() =>
      prisma.$transaction((tx) =>
        claimEmailedCode(tx, {
          runId,
          spaceId,
          botId,
          emailId: email.id,
          emailKey: email.key,
          site: "example.test",
        }),
      ),
    ).then(
      () => true,
      (error) => {
        if (error instanceof EmailedCodeTaken) return false;
        throw error;
      },
    );

  const lookup = (runId: string) => ({
    botId,
    spaceId,
    runId,
    userId,
    origin,
    after: new Date(Date.now() - 60_000),
    botEmailDomain: "bots.test",
    sources: { inbox: true, connected: undefined },
  });

  const connectedClaim = (messageId: string) => {
    const hash = createHash("sha256").update(`owner@example.net:${messageId}`);
    return `emailed-code:connected:${hash.digest("base64url")}`;
  };
  /** Claim a message of a connected mailbox as a run keeping its code does: false when taken. */
  const claimConnected = (runId: string, messageId: string, site = "example.test") =>
    system(() =>
      prisma.$transaction((tx) =>
        claimConnectedMailCode(tx, {
          runId,
          spaceId,
          mailbox: "owner@example.net",
          messageId,
          site,
        }),
      ),
    ).then(
      () => true,
      (error) => {
        if (error instanceof EmailedCodeTaken) return false;
        throw error;
      },
    );

  it("gives a connected mailbox's message to one run, and a site's code once in all", async () => {
    const runId = await newRun("running");
    const other = await newRun("running");
    // Two runs want the same message: one gets it.
    const claims = await Promise.all([
      claimConnected(runId, "message-1"),
      claimConnected(other, "message-1"),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const taker = claims[0] ? runId : other;
    const loser = claims[0] ? other : runId;
    // Neither another connected message nor the bot's own inbox gives the taker a second code
    // for the site in this run; a code for another site is still free.
    expect(await claimConnected(taker, "message-2")).toBe(false);
    expect(await claimFor(taker, await receive("884201"))).toBe(false);
    expect(await claimConnected(taker, "message-3", "other.example")).toBe(true);
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
    expect(keys.filter((key) => key.startsWith("emailed-code:email:"))).toHaveLength(1);
    expect(keys.filter((key) => !key.startsWith("emailed-code:email:")).sort()).toEqual(
      [
        connectedClaim("message-1"),
        connectedClaim("message-3"),
        `emailed-code:run:${taker}:example.test`,
        `emailed-code:run:${taker}:other.example`,
        `emailed-code:run:${loser}:example.test`,
      ].sort(),
    );
    // This case's inbox mail would make the site's code ambiguous for the cases after it.
    await system(() => prisma.botEmailMessage.deleteMany({ where: { botId } }));
  });

  it("never takes mail saved before it was known whether it came through a list", async () => {
    // As the previous release saves mail while it still runs, and as every older row reads.
    const runId = runs[0]!;
    await receive("482913", "no-reply@example.test", {});
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
          idempotencyKey: { startsWith: "emailed-code:email:" },
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

  /** The runs that took the email's code: one claim per run and site, one per message. */
  const takers = (emailId: string) =>
    system(async () =>
      (
        await prisma.externalEffect.findMany({
          where: {
            kind: "emailed_code",
            idempotencyKey: { startsWith: "emailed-code:email:" },
            request: { path: ["emailId"], equals: emailId },
          },
          select: { runId: true },
        })
      ).map((effect) => effect.runId),
    );
  const heldCodes = (runId: string) =>
    system(() => prisma.secret.count({ where: { userId, kind: runCodeKind(runId) } }));

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
    const hold = (over: { scope?: typeof scope } = {}) =>
      system(() =>
        holdEmailedCode(prisma, secretStore, {
          ...lookup(runId),
          scope,
          request: { id: request.id, from: "intended", result: answer },
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
