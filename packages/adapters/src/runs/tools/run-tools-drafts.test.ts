import type * as Db from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as RunMessages from "../assembly/run-messages.js";
import { draftClientNonce, draftTools } from "./run-tools-drafts.js";

const publishMessage = vi.hoisted(() => vi.fn());
vi.mock("../assembly/run-messages.js", async (importActual) => ({
  ...(await importActual<typeof RunMessages>()),
  publishMessage: (...args: unknown[]) => publishMessage(...args),
}));

const appendEventInTransaction = vi.hoisted(() => vi.fn(async () => ({ seq: 7 })));
vi.mock("@rakazo/db", async (importActual) => ({
  ...(await importActual<typeof Db>()),
  appendEventInTransaction: (...args: unknown[]) => appendEventInTransaction(...(args as [])),
}));

const run = { id: "run-1", spaceId: "space-1", userId: "user-1", threadId: "t-1", botId: "bot-1" };

function context(stored?: { botId: string; blocks: unknown[] }, secrets: string[] = []) {
  const tx = {
    $queryRaw: vi.fn(async () => []),
    message: {
      findUnique: vi.fn(async () => (stored ? { id: "message-1", ...stored } : null)),
      update: vi.fn(async () => ({})),
    },
  };
  const notify = vi.fn(async () => undefined);
  const ctx = {
    deps: {
      prisma: { $transaction: vi.fn(async (work: (client: unknown) => unknown) => work(tx)) },
      events: { notify },
    },
    run,
    secrets,
  } as never;
  return { ctx, tx, notify };
}

const call = (args: Record<string, unknown>) =>
  ({ args, finish: (result: unknown) => result }) as never;

const draft = {
  kind: "draft",
  draftId: "d-1",
  label: "Email",
  to: "Ana",
  body: "Hello Ana",
  version: 2,
};

describe("write_draft", () => {
  beforeEach(() => publishMessage.mockReset());

  it("posts a new draft as a card it can find again, with secrets redacted", async () => {
    const secret = "FAKE_DRAFT_SECRET_4410";
    const { ctx } = context(undefined, [secret]);
    const result = (await draftTools.write_draft!(
      ctx,
      call({ label: " LinkedIn message ", to: "", body: `Hi, my code is ${secret}` }),
    )) as { draftId: string; version: number };
    expect(result.version).toBe(1);
    const [, , role, blocks, , nonce] = publishMessage.mock.calls[0]!;
    expect(role).toBe("bot");
    expect(nonce).toBe(draftClientNonce(result.draftId));
    expect(blocks).toEqual([
      {
        kind: "draft",
        draftId: result.draftId,
        label: "LinkedIn message",
        body: expect.not.stringContaining(secret),
        version: 1,
      },
    ]);
  });

  it("refuses a draft without a body, a new one without a label, or one too long", async () => {
    const { ctx } = context();
    await expect(draftTools.write_draft!(ctx, call({ label: "Email" }))).resolves.toEqual({
      error: "A draft needs a body.",
    });
    await expect(draftTools.write_draft!(ctx, call({ body: "Hi" }))).resolves.toEqual({
      error: "A new draft needs a label.",
    });
    await expect(
      draftTools.write_draft!(ctx, call({ label: "x".repeat(61), body: "Hi" })),
    ).resolves.toMatchObject({ error: expect.stringContaining("label") });
    expect(publishMessage).not.toHaveBeenCalled();
  });

  it("rewrites the same card for a revision and signals the thread", async () => {
    const other = { kind: "text", text: "Here it is" };
    const { ctx, tx, notify } = context({ botId: "bot-1", blocks: [other, draft] });
    const result = await draftTools.write_draft!(
      ctx,
      call({ draftId: "d-1", body: "Hello Ana, thanks", subject: "Thanks" }),
    );
    expect(result).toMatchObject({ draftId: "d-1", version: 3 });
    expect(tx.message.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { threadId_clientNonce: { threadId: "t-1", clientNonce: "draft:d-1" } },
      }),
    );
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "message-1" },
      data: {
        blocks: [other, { ...draft, subject: "Thanks", body: "Hello Ana, thanks", version: 3 }],
      },
    });
    expect(appendEventInTransaction).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        type: "thread.message.updated",
        payload: expect.objectContaining({ messageId: "message-1" }),
      }),
    );
    expect(notify).toHaveBeenCalledWith("t-1", 7);
    expect(publishMessage).not.toHaveBeenCalled();
  });

  it("removes a recipient or subject a revision leaves blank", async () => {
    const { ctx, tx } = context({ botId: "bot-1", blocks: [{ ...draft, subject: "Hi" }] });
    await draftTools.write_draft!(
      ctx,
      call({ draftId: "d-1", body: "Hey", to: "", subject: null }),
    );
    const { to: _to, ...withoutRecipient } = draft;
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "message-1" },
      data: { blocks: [{ ...withoutRecipient, body: "Hey", version: 3 }] },
    });
  });

  it("does not revise another bot's draft or one that is not in the chat", async () => {
    for (const stored of [undefined, { botId: "bot-2", blocks: [draft] }]) {
      const { ctx, tx } = context(stored);
      const result = await draftTools.write_draft!(ctx, call({ draftId: "d-1", body: "New" }));
      expect(result).toMatchObject({ error: expect.stringContaining("No draft") });
      expect(tx.message.update).not.toHaveBeenCalled();
    }
  });
});
