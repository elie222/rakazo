import { randomUUID } from "node:crypto";
import { EncryptedSecretStore, withSecretPersistence } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { createDb, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { moveMcpArgsIntoSecrets } from "./mcp-args-migration.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

describe
  .skipIf(!enabled)
  .sequential("moving MCP server arguments into secrets (PostgreSQL)", () => {
    let db: ReturnType<typeof createDb>;
    let prisma: PrismaClient;
    const suffix = randomUUID();
    const userId = `mcp-args-user-${suffix}`;
    const spaceId = `mcp-args-space-${suffix}`;
    const organizationId = `mcp-args-org-${suffix}`;
    const secrets = new EncryptedSecretStore("fake-mcp-args-test-encryption-key");
    const context = {
      operationId: "test",
      traceId: "test",
      spaceId,
      userId,
      signal: new AbortController().signal,
    };
    const server = (slug: string, data: Record<string, unknown> = {}) =>
      prisma.mcpServer.create({
        data: { spaceId, userId, slug, name: slug, transport: "stdio", command: "npx", ...data },
      });
    const materialOf = async (secretId: string | null) => {
      const secret = await prisma.secret.findUniqueOrThrow({ where: { id: secretId ?? "" } });
      return JSON.parse(await secrets.load(secret.ciphertext, secret.id));
    };

    beforeAll(() =>
      runAsSystem("mcp args migration fixture", async () => {
        db = createDb(process.env.DATABASE_URL!);
        prisma = withSecretPersistence(db.prisma, secrets);
        await prisma.user.create({
          data: { id: userId, name: "Args", email: `${userId}@example.test`, emailVerified: false },
        });
        await prisma.organization.create({
          data: { id: organizationId, name: "Args", slug: organizationId, createdAt: new Date() },
        });
        await prisma.space.create({
          data: {
            id: spaceId,
            organizationId,
            name: "General",
            isDefault: true,
            createdByUserId: userId,
          },
        });
      }),
    );
    afterAll(() =>
      runAsSystem("mcp args migration fixture", async () => {
        if (prisma) {
          await prisma.organization.deleteMany({ where: { id: organizationId } });
          await prisma.user.deleteMany({ where: { id: userId } });
          await prisma.$disconnect();
          await db.pool.end();
        }
        await secrets.close();
      }),
    );

    it("encrypts plaintext arguments, keeps other credentials, and leaves the column empty", () =>
      runAsSystem("mcp args migration", async () => {
        const bare = await server("bare", { args: ["--api-key", "fake-key"] });
        const existing = await secrets.put(
          JSON.stringify({ env: { API_KEY: "fake-env" } }),
          context,
        );
        await prisma.secret.create({
          data: { id: existing.id, userId, spaceId, kind: "mcp", ciphertext: existing.ciphertext },
        });
        const withSecret = await server("with-secret", { args: ["serve"], secretId: existing.id });
        const current = await server("current", { hasArgs: false });

        // Other suites share the database, so this checks rows rather than counts.
        await moveMcpArgsIntoSecrets(prisma, secrets, { dryRun: true });
        expect(await prisma.mcpServer.findUniqueOrThrow({ where: { id: bare.id } })).toMatchObject({
          args: ["--api-key", "fake-key"],
          secretId: null,
        });
        await moveMcpArgsIntoSecrets(prisma, secrets);

        const bareRow = await prisma.mcpServer.findUniqueOrThrow({ where: { id: bare.id } });
        expect(bareRow).toMatchObject({ args: [], hasArgs: true });
        expect(await materialOf(bareRow.secretId)).toEqual({ args: ["--api-key", "fake-key"] });
        const secretRow = await prisma.mcpServer.findUniqueOrThrow({
          where: { id: withSecret.id },
        });
        expect(secretRow).toMatchObject({ args: [], hasArgs: true });
        expect(await materialOf(secretRow.secretId)).toEqual({
          env: { API_KEY: "fake-env" },
          args: ["serve"],
        });
        expect(await prisma.secret.findUnique({ where: { id: existing.id } })).toBeNull();
        expect(
          await prisma.mcpServer.findUniqueOrThrow({ where: { id: current.id } }),
        ).toMatchObject({ secretId: null, hasArgs: false });
      }));
  });
