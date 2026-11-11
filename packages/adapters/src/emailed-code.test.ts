import { createHash } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { answerCodeCardsFromInbox, EMAILED_CODE_WINDOW_MS } from "./emailed-code.js";

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
    answered?: boolean | Error;
    /** The origin each run's browser was on when it asked; absent means it was not seen. */
    pages?: Record<string, string | null>;
    /** Effects already recorded, by idempotency key. */
    effects?: Record<string, Row>;
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
          : options.answeredAt
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
        where: { receivedAt: { gte: Date; gt?: Date } };
        cursor?: { id: string };
        skip?: number;
        take?: number;
      }) => {
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
  };
  const deliver = (runId?: string) =>
    answerCodeCardsFromInbox(
      {
        prisma: prisma as unknown as PrismaClient,
        events: { answerRunInput } as never,
        jobs: { enqueue },
        botEmailDomain: "bots.test",
      },
      bot,
      runId,
    );
  return {
    deliver,
    answerRunInput,
    enqueue,
    prisma: prisma as typeof prisma & { run: { findMany: ReturnType<typeof vi.fn> } },
    effects,
  };
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
