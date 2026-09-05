import { randomUUID } from "node:crypto";
import { bootstrapUserSpace, createDb, createThreadEvents, requireMembership } from "@rakazo/db";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  companyOsEndpoint,
  createCompanyOsWorkforce,
  type WorkforcePeer,
} from "./company-os-workforce.js";
import { InMemoryRealtimeFanout } from "./realtime.js";
import { EncryptedSecretStore } from "./secrets.js";

describe("Company OS destination validation", () => {
  it("never sends credentials to redirects, local networks, or arbitrary origins", () => {
    for (const url of [
      "http://localhost/api/mcp",
      "https://127.0.0.1/api/mcp",
      "https://evil.example/api/mcp",
      "https://user:secret@www.companyos.sh/api/mcp",
      "https://www.companyos.sh/api/mcp?url=evil",
    ])
      expect(() => companyOsEndpoint(url)).toThrow();
    expect(companyOsEndpoint("https://www.companyos.sh/api/mcp")).toBe(
      "https://www.companyos.sh/api/mcp",
    );
  });
});

const databaseUrl = process.env.VERIFY_DATABASE ? process.env.DATABASE_URL : undefined;
describe.skipIf(!databaseUrl)("durable workforce delivery", () => {
  const db = databaseUrl ? createDb(databaseUrl) : null;
  afterAll(async () => {
    await db?.prisma.$disconnect();
    await db?.pool.end();
  });
  it.each([false, true])(
    "replays dispatch and completion without exposing credentials (OAuth: %s)",
    async (oauth) => {
      const { prisma, pool } = db!;
      const userId = randomUUID();
      await prisma.user.create({
        data: { id: userId, email: `${userId}@example.com`, name: "Workforce test" },
      });
      const { spaceId } = await bootstrapUserSpace(
        prisma,
        { id: userId },
        { signupsEnabled: "true", signupAllowlist: undefined },
        { claimDeploymentOwner: false },
      );
      try {
        const actor = await requireMembership(prisma, userId, spaceId);
        const key = "test-company-key-not-a-real-credential";
        const secrets = new EncryptedSecretStore("test-encryption-key-long-enough-for-tests");
        const events = createThreadEvents(prisma, new InMemoryRealtimeFanout());
        let dispatch:
          | {
              dispatchId: string;
              seq: number;
              workerId: string;
              title: string;
              brief: string;
              status: "claimed";
            }
          | undefined;
        let completed = false;
        const sync = vi.fn<WorkforcePeer["sync"]>(async (input) => {
          if (input.enabled && input.workers.length && !dispatch)
            dispatch = {
              dispatchId: `1:1:${input.workers[0]!.id}`,
              seq: 1,
              workerId: input.workers[0]!.id,
              title: "Research",
              brief: "Find a source",
              status: "claimed",
            };
          const report = input.reports.find((r) => r.status === "completed");
          if (report) completed = true;
          return {
            protocol: 1,
            company: { name: "Example", slug: "example" },
            assignments: dispatch && !completed ? [dispatch] : [],
            acknowledged: report ? [report.dispatchId] : [],
          };
        });
        const enqueue = vi.fn(async () => {});
        let token = key;
        let companySlug = "example";
        const oauthCredential = vi.fn(async () => ({
          token,
          identity: {
            company: { id: "company-1", slug: companySlug, name: "Example" },
            capabilities: ["context:read", "context:write"],
          },
        }));
        const deps = {
          ...(oauth ? { oauthCredential } : {}),
          prisma,
          pool,
          secrets,
          events,
          jobs: { enqueue, cancel: vi.fn(async () => {}), close: vi.fn(async () => {}) },
          connect: vi.fn(async () => ({
            sync,
            tools: async () => [
              "document_get",
              "document_put",
              "work_claim",
              "work_complete",
              "workforce_sync",
            ],
            close: async () => {},
          })),
        };
        const workforce = createCompanyOsWorkforce(deps);
        const connection = await workforce.configure(actor, {
          endpoint: "https://www.companyos.sh/api/mcp",
          ...(oauth ? {} : { key }),
          enabled: true,
          workers: [{ name: "Researcher", instructions: "Research", model: "test/model" }],
        });
        if (oauth) {
          expect(
            (await prisma.workforceConnection.findUniqueOrThrow({ where: { id: connection.id } }))
              .credential,
          ).toBe("oauth:company-os");
          token = "rotated-test-access-token";
        }
        await workforce.tickConnection(connection.id);
        if (oauth) {
          expect(deps.connect).toHaveBeenLastCalledWith("https://www.companyos.sh/api/mcp", token);
          const server = await prisma.mcpServer.findFirstOrThrow({
            where: { spaceId, userId, slug: "company-os-workforce" },
            include: { secret: true },
          });
          expect(secrets.load(server.secret!.ciphertext, server.secret!.id)).toBe(
            JSON.stringify({ secret: token }),
          );
        }
        const receipt = await prisma.workforceAssignment.findFirstOrThrow({
          where: { connectionId: connection.id },
        });
        expect(receipt.runId).toBeTruthy();
        // Recreate the dispatcher as after a worker restart. Retrying cannot create a second run.
        await Promise.all([
          workforce.tickConnection(connection.id),
          createCompanyOsWorkforce(deps).tickConnection(connection.id),
        ]);
        expect(
          await prisma.workforceAssignment.count({ where: { connectionId: connection.id } }),
        ).toBe(1);
        expect(await prisma.run.count({ where: { spaceId } })).toBe(1);
        const run = await prisma.run.findUniqueOrThrow({ where: { id: receipt.runId! } });
        await prisma.run.update({ where: { id: run.id }, data: { status: "completed" } });
        await prisma.message.create({
          data: {
            threadId: run.threadId,
            seq: 2,
            role: "bot",
            botId: run.botId,
            runId: run.id,
            blocks: [{ kind: "text", text: "Verified source saved on the research branch." }],
          },
        });
        await workforce.tickConnection(connection.id);
        const status = await workforce.status(actor);
        expect(status!.assignments[0]!.synced).toBe(true);
        expect(JSON.stringify(status)).not.toContain(key);
        const server = await prisma.botMcpServer.findFirstOrThrow({ where: { botId: run.botId } });
        expect(server.allowedTools).toEqual(["document_get", "document_put"]);
        if (oauth) {
          const calls = deps.connect.mock.calls.length;
          companySlug = "another-company";
          await workforce.tickConnection(connection.id);
          expect(deps.connect.mock.calls.length).toBe(calls);
          expect((await workforce.status(actor))!.lastError).toContain("Sync failed");
          companySlug = "example";
          oauthCredential.mockRejectedValue(new Error("OAuth grant revoked"));
          await workforce.tickConnection(connection.id);
          expect(deps.connect.mock.calls.length).toBe(calls);
          expect((await workforce.status(actor))!.lastError).toContain("Sync failed");
        }
        const outsider = { ...actor, userId: "other-user" };
        expect(await workforce.status(outsider)).toBeNull();
      } finally {
        await prisma.space.delete({ where: { id: spaceId } });
        await prisma.user.delete({ where: { id: userId } });
      }
    },
  );
});
