import type {
  AdapterContext,
  TurnMemoryCapture,
  TurnMemoryCaptureResult,
} from "@rakazo/adapter-kit";
import { encodeLoginSecret } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  deleteRunSecretsInTransaction,
  runCodeKind,
  runCodeSpentKind,
  runLoginKind,
} from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  encodeRunCode,
  encodeRunLogin,
  loadRunCodeRedactions,
  loadRunLoginRedactions,
} from "./bot-secrets.js";
import { fakeDatabase } from "./bot-secrets.test-support.js";
import type { CaptureTurnRunRow, MemoryCapturePrisma } from "./memory-capture.js";
import { captureFinishedTurn } from "./memory-capture.js";
import type { MemoryProviderResolver } from "./memory-provider-factory.js";
import { EncryptedSecretStore } from "./secrets.js";

const scope = { userId: "user-1", spaceId: "space-1", botId: "bot-1" };
const origin = "https://login.example.test";
const context: AdapterContext = {
  ...scope,
  operationId: "fixture",
  traceId: "fixture",
  signal: new AbortController().signal,
};

function captureFixture(evidence: string) {
  const db = fakeDatabase();
  const secretStore = new EncryptedSecretStore("test-only-encryption-key");
  const load = vi.fn(secretStore.load.bind(secretStore));
  secretStore.load = load;
  const row: CaptureTurnRunRow = {
    ...scope,
    id: "run-1",
    threadId: "thread-1",
    status: "completed",
    startedAt: new Date("2026-11-04T10:00:00Z"),
    completedAt: new Date("2026-11-04T10:00:05Z"),
    sourceMessageId: "source-1",
    memoryCaptureDueAt: new Date("2026-11-04T10:00:05Z"),
    memoryCapturedAt: null,
    memoryRecallIds: [],
    memoryCaptureScope: "isolated",
    memoryCapturePayload: null,
  };
  const secrets: Array<{
    id: string;
    ciphertext: string;
    userId: string;
    spaceId: string;
    kind: string;
  }> = [];
  const purchases: Array<{
    id: string;
    userId: string;
    spaceId: string;
    botId: string;
    createdAt: Date;
    cardCiphertext: string | null;
    tokenCiphertext: string | null;
  }> = [];
  const purchase = {
    findMany: vi.fn(
      async ({
        where,
      }: {
        where: {
          userId: string;
          spaceId: string;
          botId: string;
          createdAt: { gte: Date };
        };
      }) =>
        purchases.filter(
          (entry) =>
            entry.userId === where.userId &&
            entry.spaceId === where.spaceId &&
            entry.botId === where.botId &&
            entry.createdAt >= where.createdAt.gte &&
            (entry.cardCiphertext !== null || entry.tokenCiphertext !== null),
        ),
    ),
  };
  const secret = {
    findMany: vi.fn(
      async ({
        where,
      }: {
        where: {
          userId: string;
          spaceId: string;
          kind: { startsWith?: string; in?: string[] };
        };
      }) =>
        secrets.filter(
          (entry) =>
            entry.userId === where.userId &&
            entry.spaceId === where.spaceId &&
            (where.kind.startsWith !== undefined
              ? entry.kind.startsWith(where.kind.startsWith)
              : where.kind.in?.includes(entry.kind)),
        ),
    ),
  };
  const run: MemoryCapturePrisma["run"] = {
    findUnique: vi.fn(async () => structuredClone(row)),
    findMany: vi.fn(async () => (row.memoryCapturedAt === null ? [{ id: row.id }] : [])),
    updateMany: vi.fn(async ({ data }) => {
      if (row.memoryCapturedAt !== null) return { count: 0 };
      if ("memoryCaptureAttempts" in data) {
        row.memoryCaptureAttempts =
          (row.memoryCaptureAttempts ?? 0) + data.memoryCaptureAttempts.increment;
      } else {
        if (row.memoryCapturePayload !== null) return { count: 0 };
        row.memoryCapturePayload = structuredClone(data.memoryCapturePayload);
      }
      return { count: 1 };
    }),
    update: vi.fn(async ({ data }) => {
      row.memoryCapturedAt = data.memoryCapturedAt;
      row.memoryCapturePayload = null;
      return structuredClone(row);
    }),
  };
  const message: MemoryCapturePrisma["message"] = {
    findFirst: vi.fn(async () => ({
      seq: 1,
      blocks: [{ kind: "text", text: `Question: ${evidence}` }],
    })),
    findMany: vi.fn(async () => [
      {
        blocks: [
          { kind: "text", text: `Answer: ${evidence}` },
          { kind: "subagent", name: evidence, task: evidence, result: evidence },
        ],
      },
    ]),
  };
  // Only database I/O and the provider transport are fake. The credential loaders,
  // authenticated encryption, payload builder and redactor are the production code.
  const prisma = Object.assign(db.prisma, { run, message, secret, purchase });
  const captureTurn = vi.fn<(capture: TurnMemoryCapture) => Promise<TurnMemoryCaptureResult>>(
    async () => ({ status: "stored" }),
  );
  const memoryProviders: MemoryProviderResolver = {
    resolve: vi.fn(async () => null),
    resolveTurnMemory: vi.fn(async () => ({
      kind: "configured" as const,
      lifecycle: { beforeTurn: vi.fn(async () => null), captureTurn },
      defaultScope: "isolated" as const,
    })),
  };
  return {
    db,
    row,
    run,
    secret,
    secrets,
    purchases,
    purchase,
    secretStore,
    load,
    captureTurn,
    deps: {
      prisma: prisma as unknown as MemoryCapturePrisma,
      memoryProviders,
      secretStore,
    },
    async addRunSecret(kind: string, plaintext: string, owner = scope) {
      const stored = await secretStore.put(plaintext, context, { ephemeral: true });
      const entry = { ...stored, userId: owner.userId, spaceId: owner.spaceId, kind };
      secrets.push(entry);
      return entry;
    },
  };
}

function expectRedactedCapture(fixture: ReturnType<typeof captureFixture>, forms: string[]) {
  expect(fixture.captureTurn).toHaveBeenCalledOnce();
  const capture = fixture.captureTurn.mock.calls[0]![0];
  expect(capture.toolCalls).toHaveLength(1);
  expect(capture.toolResults).toHaveLength(1);
  const fields = [
    capture.query,
    capture.answer,
    ...capture.toolCalls.flatMap((call) => [call.name, call.input]),
    ...capture.toolResults.flatMap((result) => [result.name, result.output]),
  ];
  for (const field of fields) {
    for (const form of forms) expect(field).not.toContain(form);
    expect(field).toContain("[redacted]");
  }
  // Secrets must be gone before the temporary outbox snapshot is persisted, not
  // merely removed by a provider implementation at the final network boundary.
  const writes = JSON.stringify(vi.mocked(fixture.run.updateMany).mock.calls);
  for (const form of forms) expect(writes).not.toContain(form);
}

describe("background turn-memory credential redaction", () => {
  it("redacts stored run-only login fields before freezing source, bot and tool evidence", async () => {
    const username = "fixture-run-user+one@example.test";
    const password = "fixture-run pass!word+one";
    const forms = [
      username,
      encodeURIComponent(username),
      password,
      encodeURIComponent(password),
      new URLSearchParams({ v: password }).toString().slice(2),
      Buffer.from(password).toString("base64"),
    ];
    const fixture = captureFixture(forms.join(" | "));
    await fixture.addRunSecret(
      runLoginKind(fixture.row.id, "site_login"),
      encodeRunLogin(
        origin,
        encodeLoginSecret({
          fields: [
            { label: "Username", value: username, hidden: false },
            { label: "Password", value: password, hidden: true },
          ],
        }),
      ),
    );

    await captureFinishedTurn(fixture.deps, fixture.row.id);

    expectRedactedCapture(fixture, forms);
  });

  it.each([
    { name: "waiting", kind: runCodeKind },
    { name: "spent", kind: runCodeSpentKind },
  ])(
    "redacts a stored $name one-time code including rendered forms from every evidence field",
    async ({ kind }) => {
      const code = "F7A-39C";
      const forms = [code, "F7A39C", "f7a-39c", "f7a39c", "F\n7\nA\n3\n9\nC", "F7A 39C"];
      const fixture = captureFixture(forms.join(" | "));
      await fixture.addRunSecret(kind(fixture.row.id), encodeRunCode(origin, code));

      await captureFinishedTurn(fixture.deps, fixture.row.id);

      expectRedactedCapture(fixture, forms);
    },
  );

  it.each(["card", "token"] as const)(
    "redacts sealed purchase %s evidence without requiring a live wallet provider",
    async (kind) => {
      const value = kind === "card" ? "4242424242424242" : "fixture-pay-token+one";
      const forms =
        kind === "card" ? [value, "4242 4242 4242 4242", "4242-4242-4242-4242"] : [value];
      const fixture = captureFixture(forms.join(" | "));
      const id = "purchase-1";
      const stored = await fixture.secretStore.put(
        kind === "card" ? value : JSON.stringify([value]),
        context,
        { recordId: `purchase-${kind}:${id}` },
      );
      fixture.purchases.push({
        ...scope,
        id,
        createdAt: new Date(),
        cardCiphertext: kind === "card" ? stored.ciphertext : null,
        tokenCiphertext: kind === "token" ? stored.ciphertext : null,
      });

      await captureFinishedTurn(fixture.deps, fixture.row.id);

      expectRedactedCapture(fixture, forms);
    },
  );

  it.each([
    { name: "another run with the same id prefix", runId: "run-10", owner: scope },
    { name: "another user", runId: "run-1", owner: { ...scope, userId: "user-other" } },
    { name: "another space", runId: "run-1", owner: { ...scope, spaceId: "space-other" } },
  ])("does not decrypt a run login owned by $name", async ({ runId, owner }) => {
    const marker = "fixture-unrelated-login";
    const fixture = captureFixture(marker);
    await fixture.addRunSecret(
      runLoginKind(runId, "site_login"),
      encodeRunLogin(
        origin,
        encodeLoginSecret({ fields: [{ label: "Password", value: marker, hidden: true }] }),
      ),
      owner,
    );

    await captureFinishedTurn(fixture.deps, fixture.row.id);

    expect(fixture.load).not.toHaveBeenCalled();
    expect(fixture.captureTurn.mock.calls[0]![0].query).toContain(marker);
  });

  it.each([
    { name: "another bot", owner: { ...scope, botId: "bot-other" }, createdAt: new Date() },
    { name: "another user", owner: { ...scope, userId: "user-other" }, createdAt: new Date() },
    { name: "another space", owner: { ...scope, spaceId: "space-other" }, createdAt: new Date() },
    { name: "outside the existing redaction window", owner: scope, createdAt: new Date(0) },
  ])("does not decrypt a purchase from $name", async ({ owner, createdAt }) => {
    const marker = "fixture-unrelated-payment-token";
    const fixture = captureFixture(marker);
    const stored = await fixture.secretStore.put(JSON.stringify([marker]), context, {
      recordId: "purchase-token:purchase-other",
    });
    fixture.purchases.push({
      ...owner,
      id: "purchase-other",
      createdAt,
      cardCiphertext: null,
      tokenCiphertext: stored.ciphertext,
    });

    await captureFinishedTurn(fixture.deps, fixture.row.id);

    expect(fixture.load).not.toHaveBeenCalled();
    expect(fixture.captureTurn.mock.calls[0]![0].query).toContain(marker);
  });

  it("replays only the redacted snapshot after a retry even if the run credential was deleted", async () => {
    const code = "C8B-52D";
    const fixture = captureFixture(code);
    await fixture.addRunSecret(runCodeSpentKind(fixture.row.id), encodeRunCode(origin, code));
    fixture.captureTurn.mockResolvedValueOnce({ status: "retryable", reason: "ack_lost" });

    await expect(captureFinishedTurn(fixture.deps, fixture.row.id)).rejects.toThrow("retryable");

    expectRedactedCapture(fixture, [code]);
    const first = structuredClone(fixture.captureTurn.mock.calls[0]![0]);
    expect(fixture.row.memoryCapturePayload).toEqual(first);
    fixture.secrets.splice(0);
    fixture.load.mockClear();
    fixture.secret.findMany.mockClear();
    fixture.purchase.findMany.mockClear();
    vi.mocked(fixture.deps.prisma.message.findFirst!).mockRejectedValue(
      new Error("must not rebuild"),
    );

    await captureFinishedTurn(fixture.deps, fixture.row.id);

    expect(fixture.captureTurn).toHaveBeenCalledTimes(2);
    expect(fixture.captureTurn.mock.calls[1]![0]).toEqual(first);
    expect(fixture.load).not.toHaveBeenCalled();
    expect(fixture.secret.findMany).not.toHaveBeenCalled();
    expect(fixture.purchase.findMany).not.toHaveBeenCalled();
    expect(fixture.row.memoryCapturedAt).toBeInstanceOf(Date);
    expect(fixture.row.memoryCapturePayload).toBeNull();
  });

  it.each(["run", "purchase"] as const)(
    "does not freeze or send evidence when the %s credential query fails",
    async (kind) => {
      const fixture = captureFixture("fixture-must-not-send");
      const failure = new Error("fixture database unavailable");
      (kind === "run" ? fixture.secret : fixture.purchase).findMany.mockRejectedValueOnce(failure);

      await expect(captureFinishedTurn(fixture.deps, fixture.row.id)).rejects.toBe(failure);

      expect(fixture.captureTurn).not.toHaveBeenCalled();
      expect(fixture.run.updateMany).not.toHaveBeenCalled();
      expect(fixture.row.memoryCapturePayload).toBeNull();
      expect(fixture.row.memoryCapturedAt).toBeNull();
    },
  );

  it("cannot recover run-only redaction values after the terminal cleanup has deleted their rows", async () => {
    const marker = "fixture-deleted-run-password";
    const fixture = captureFixture(marker);
    await fixture.addRunSecret(
      runLoginKind(fixture.row.id, "site_login"),
      encodeRunLogin(
        origin,
        encodeLoginSecret({ fields: [{ label: "Password", value: marker, hidden: true }] }),
      ),
    );
    await fixture.addRunSecret(runCodeKind(fixture.row.id), encodeRunCode(origin, "D9C-63F"));
    await fixture.addRunSecret(runCodeSpentKind(fixture.row.id), encodeRunCode(origin, "E2D-74G"));
    const deleteMany = vi.fn(
      async ({
        where,
      }: {
        where: {
          OR: Array<{ userId: string; spaceId: string; kind: string | { startsWith: string } }>;
        };
      }) => {
        const remaining = fixture.secrets.filter(
          (entry) =>
            !where.OR.some(
              (match) =>
                entry.userId === match.userId &&
                entry.spaceId === match.spaceId &&
                (typeof match.kind === "string"
                  ? entry.kind === match.kind
                  : entry.kind.startsWith(match.kind.startsWith)),
            ),
        );
        const count = fixture.secrets.length - remaining.length;
        fixture.secrets.splice(0, fixture.secrets.length, ...remaining);
        return { count };
      },
    );

    // finalizeRun calls this same cleanup inside its terminal transaction, before
    // the background job can read the run. No secret copy is retained by capture.
    await deleteRunSecretsInTransaction({ secret: { deleteMany } } as unknown as PrismaClient, [
      { id: fixture.row.id, userId: scope.userId, spaceId: scope.spaceId },
    ]);

    expect(fixture.secrets).toEqual([]);
    const prisma = fixture.deps.prisma as unknown as PrismaClient;
    expect(
      await loadRunLoginRedactions(prisma, fixture.secretStore, scope, fixture.row.id),
    ).toEqual([]);
    expect(await loadRunCodeRedactions(prisma, fixture.secretStore, scope, fixture.row.id)).toEqual(
      [],
    );
    expect(fixture.load).not.toHaveBeenCalled();
    expect(fixture.row.memoryCapturePayload).toBeNull();
  });
});
