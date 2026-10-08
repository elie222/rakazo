import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createSecretMigrationRepository } from "./secret-migration.js";

function fixture() {
  const tables = {
    secret: Array.from({ length: 101 }, (_, i) => ({
      id: `row-${String(i).padStart(3, "0")}`,
      ciphertext: `fake-ref-${i}`,
      kind: i === 0 ? "run-secret:run" : "model",
    })),
    botSecret: [{ id: "bot-row", ciphertext: "fake-bot-ref" }],
    integrationProviderConfig: [{ id: "composio", ciphertext: "fake-config-ref" }],
  };
  const client = Object.fromEntries(
    Object.entries(tables).map(([name, rows]) => [
      name,
      {
        findMany: vi.fn(
          async (args: {
            where?: { id: { gt: string } };
            take: number;
            orderBy: { id: string };
          }) => {
            expect(args.orderBy).toEqual({ id: "asc" });
            return rows
              .filter((row) => !args.where || row.id > args.where.id.gt)
              .slice(0, args.take);
          },
        ),
        updateMany: vi.fn(
          async (args: {
            where: { id: string; ciphertext: string };
            data: { ciphertext: string };
          }) => {
            const row = rows.find(
              (row) => row.id === args.where.id && row.ciphertext === args.where.ciphertext,
            );
            if (!row) return { count: 0 };
            row.ciphertext = args.data.ciphertext;
            return { count: 1 };
          },
        ),
        count: vi.fn(
          async (args: { where: { ciphertext: string } }) =>
            rows.filter((row) => row.ciphertext === args.where.ciphertext).length,
        ),
      },
    ]),
  );
  return { tables, repository: createSecretMigrationRepository(client as unknown as PrismaClient) };
}
describe("migration persistence", () => {
  it("paginates every credential table, binds config ids, and marks short-lived rows", async () => {
    const f = fixture();
    const rows = [];
    for await (const row of f.repository.rows()) rows.push(row);
    expect(rows).toHaveLength(103);
    expect(rows[0]).toMatchObject({ ephemeral: true, id: "row-000", label: "secret" });
    expect(rows.at(-1)).toMatchObject({
      id: "composio",
      recordId: "integration-provider:composio",
      ref: "fake-config-ref",
    });
    expect(rows.find((row) => row.id === "bot-row")?.recordId).toBe("bot-row");
  });
  it("compares the original ref so a concurrent update or delete wins", async () => {
    const f = fixture();
    const row = (await f.repository.rows().next()).value!;
    expect(await f.repository.replace(row, "fake-next")).toBe(true);
    expect(await f.repository.replace(row, "fake-stale")).toBe(false);
    f.tables.secret.splice(0, 1);
    expect(await f.repository.replace(row, "fake-deleted")).toBe(false);
    expect(await f.repository.referenced("fake-bot-ref")).toBe(true);
    expect(await f.repository.referenced("fake-config-ref")).toBe(true);
    expect(await f.repository.referenced("fake-missing")).toBe(false);
  });
});
