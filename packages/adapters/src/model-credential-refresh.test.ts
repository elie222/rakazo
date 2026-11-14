import type { RealtimeFanout } from "@rakazo/adapter-kit";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { updateStoredModelSecret } from "./model-credential-refresh.js";
import { parseModelSecret, serializeModelSecret } from "./model-secret.js";
import { ComposedSecretStore } from "./secret-store-factory.js";
import { EncryptedSecretStore } from "./secrets.js";

const scope = { userId: "user", spaceId: "space" };
const context = {
  ...scope,
  operationId: "test",
  traceId: "test",
  signal: new AbortController().signal,
};

describe("model settings notifications", () => {
  it("releases transaction connections before publishing concurrent settings saves", async () => {
    const capacity = 4;
    let active = 0;
    let started = 0;
    let committed = 0;
    let published = 0;
    let release!: () => void;
    const allStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const encrypted = new EncryptedSecretStore("test-only-key");
    const rows = new Map<string, string>();
    for (let index = 0; index < capacity; index++) {
      const id = `secret-${index}`;
      const record = await encrypted.put(
        serializeModelSecret({ kind: "api_key", key: "fake-key" }),
        context,
        { recordId: id },
      );
      rows.set(id, record.ciphertext);
    }
    const fanout: RealtimeFanout = {
      describe: () => ({
        id: "test",
        contractVersion: "1",
        adapterVersion: "0.1.0",
        capabilities: { distributed: false, push: true },
      }),
      close: async () => {},
      subscribe: async () => async () => {},
      publish: async () => {
        // Publication needs one slot from the same bounded pool as transactions.
        expect(active).toBeLessThan(capacity);
        expect(committed).toBeGreaterThan(0);
        active++;
        published++;
        active--;
      },
    };
    const store = new ComposedSecretStore(encrypted, undefined, fanout);
    const prisma = {
      $transaction: async (work: (tx: Prisma.TransactionClient) => Promise<boolean>) => {
        active++;
        if (++started === capacity) release();
        await allStarted;
        let saved: { id: string; ciphertext: string } | undefined;
        const tx = {
          $executeRaw: async () => 0,
          secret: {
            findFirst: async ({ where }: { where: { id: string } }) => ({
              ciphertext: rows.get(where.id),
            }),
            update: async ({
              where,
              data,
            }: {
              where: { id: string };
              data: { ciphertext: string };
            }) => {
              saved = { id: where.id, ciphertext: data.ciphertext };
            },
          },
        } as unknown as Prisma.TransactionClient;
        try {
          const result = await work(tx);
          if (saved) rows.set(saved.id, saved.ciphertext);
          committed++;
          return result;
        } finally {
          active--;
        }
      },
    } as unknown as Pick<PrismaClient, "$transaction" | "secret">;
    try {
      await expect(
        Promise.all(
          [...rows.keys()].map((id) =>
            updateStoredModelSecret(prisma, store, scope, id, (secret) => ({
              ...secret,
              maxTokens: 1024,
            })),
          ),
        ),
      ).resolves.toEqual([true, true, true, true]);
      expect(committed).toBe(capacity);
      expect(published).toBe(capacity);
      expect(active).toBe(0);
      for (const [id, ciphertext] of rows) {
        expect(parseModelSecret(await store.load(ciphertext, id))).toMatchObject({
          maxTokens: 1024,
        });
      }
    } finally {
      await store.close();
    }
  });
});
