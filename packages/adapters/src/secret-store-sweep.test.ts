import type { AdapterContext } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InfisicalSecretStore } from "./infisical-secret-store.js";
import { infisicalFake } from "./secret-store-fake.js";
import {
  SECRET_SWEEP_GRACE_MS,
  secretStoreSweeper,
  sweepSecretStore,
} from "./secret-store-sweep.js";

const context: AdapterContext = {
  operationId: "test",
  traceId: "test",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};
const columns = [
  { table: "purchases", column: "cardCiphertext" },
  { table: "secrets", column: "ciphertext" },
];

/** Rows by table and column, read the way the sweep reads them. */
function database(rows: Record<string, string[]>, afterRead?: () => void) {
  const $queryRaw = vi.fn(async (query: unknown) => {
    if (Array.isArray(query)) return columns;
    const { sql, values } = query as { sql: string; values: unknown[] };
    const [, table, column] = sql.match(/FROM "([^"]+)" WHERE "([^"]+)"/) ?? [];
    const refs = values[0] as string[];
    const found = (rows[`${table}.${column}`] ?? [])
      .filter((ref) => refs.includes(ref))
      .map((ref) => ({ ref }));
    afterRead?.();
    return found;
  });
  return { prisma: { $queryRaw } as unknown as Pick<PrismaClient, "$queryRaw">, $queryRaw };
}

describe("secret store sweep", () => {
  const stores: InfisicalSecretStore[] = [];
  afterEach(async () => {
    for (const store of stores.splice(0)) await store.close();
  });

  async function setup() {
    const fake = infisicalFake();
    const store = new InfisicalSecretStore(fake.options);
    stores.push(store);
    await store.start();
    const old = new Date(Date.now() - SECRET_SWEEP_GRACE_MS - 60_000);
    const put = async (value: string, written = old) => {
      const { ref } = await store.put(value, context, { recordId: value });
      fake.created.set(ref.split(":").at(-1)!, written);
      return ref;
    };
    const kept = (ref: string) => fake.values.has(ref.split(":").at(-1)!);
    return { fake, store, put, kept };
  }

  it("removes only old entries no row holds", async () => {
    const { fake, store, put, kept } = await setup();
    const held = await put("held");
    const card = await put("card");
    const orphan = await put("orphan");
    const recent = await put("recent", new Date());
    const undated = await put("undated");
    fake.created.delete(undated.split(":").at(-1)!);
    const { prisma } = database({
      "secrets.ciphertext": [held],
      "purchases.cardCiphertext": [card],
    });

    await expect(sweepSecretStore(prisma, store)).resolves.toBe(1);
    expect([held, card, orphan, recent, undated].map(kept)).toEqual([
      true,
      true,
      false,
      true,
      true,
    ]);
    await expect(sweepSecretStore(prisma, store)).resolves.toBe(0);
  });

  it("keeps an entry a row took after the first read", async () => {
    const { store, put, kept } = await setup();
    const held = await put("held");
    const saved = await put("saved");
    const rows = { "secrets.ciphertext": [held] };
    const { prisma } = database(rows, () => {
      rows["secrets.ciphertext"] = [held, saved];
    });

    await expect(sweepSecretStore(prisma, store)).resolves.toBe(0);
    expect(kept(saved)).toBe(true);
  });

  it("deletes nothing when no row holds any old entry or the rows cannot be read", async () => {
    const { store, put, kept } = await setup();
    const orphan = await put("orphan");
    await expect(sweepSecretStore(database({}).prisma, store)).resolves.toBe(0);
    expect(kept(orphan)).toBe(true);

    const unreadable = database({});
    unreadable.$queryRaw.mockResolvedValueOnce([]);
    await expect(sweepSecretStore(unreadable.prisma, store)).rejects.toThrow("not readable");
    expect(kept(orphan)).toBe(true);
  });

  it("removes at most a bounded number of entries per pass", async () => {
    const { store, put } = await setup();
    const held = await put("held");
    for (let i = 0; i < 101; i++) await put(`orphan-${i}`);
    const { prisma } = database({ "secrets.ciphertext": [held] });

    await expect(sweepSecretStore(prisma, store)).resolves.toBe(100);
    await expect(sweepSecretStore(prisma, store)).resolves.toBe(1);
  });

  it("runs once an hour, and not at all for a store with no remote entries", async () => {
    const { store, put, kept } = await setup();
    await put("held");
    const orphan = await put("orphan");
    const { prisma } = database({});
    const list = vi.spyOn(store, "listRemote");
    const sweep = secretStoreSweeper(prisma, store)!;
    await sweep();
    await sweep();
    expect(list).toHaveBeenCalledOnce();
    expect(kept(orphan)).toBe(true);

    expect(secretStoreSweeper(prisma, { listRemote: undefined } as never)).toBeUndefined();
  });
});
