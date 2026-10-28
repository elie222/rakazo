import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import { LocalAgentHomeStore } from "@rakazo/adapters";
import type { AccountExportRecord, Actor } from "@rakazo/contracts";
import {
  AccountExportManifestSchema,
  AccountExportRecordSchema,
  accountExportPaths,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  createDb,
  createThreadMessage,
  LocalKeyProvider,
  masterKeysFromEnv,
  readAccountExport,
  runAsSystem,
} from "@rakazo/db";
import { unzipSync } from "fflate";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mountAccountExportRoute } from "./account-export.js";
import { importAccount } from "./account-import.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("account export (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const exporter = `export-user-${suffix}`;
  const other = `export-other-${suffix}`;
  const importer = `export-importer-${suffix}`;
  const importerOrg = `export-importer-org-${suffix}`;
  const importerSpace = `export-importer-space-${suffix}`;
  const personalOrg = `export-personal-${suffix}`;
  const sharedOrg = `export-shared-${suffix}`;
  const ownedSpace = `export-owned-${suffix}`;
  const sharedSpace = `export-shared-space-${suffix}`;
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;

  beforeAll(() =>
    runAsSystem("test fixture", async () => {
      // The derived key keeps rows from other suites sharing this database readable.
      const keyProvider = new LocalKeyProvider([
        { id: "export-test", key: randomBytes(32) },
        ...masterKeysFromEnv(),
      ]);
      db = createDb(databaseUrl!, { keyProvider, encryptContent: true });
      prisma = db.prisma;
      const now = new Date();
      await prisma.user.createMany({
        data: [exporter, other, importer].map((id) => ({
          id,
          name: id,
          email: `${id}@rakazo.test`,
          emailVerified: false,
        })),
      });
      await prisma.organization.createMany({
        data: [personalOrg, sharedOrg, importerOrg].map((id) => ({
          id,
          name: id,
          slug: id,
          createdAt: now,
        })),
      });
      await prisma.space.createMany({
        data: [
          { id: ownedSpace, organizationId: personalOrg, name: "Mine", isDefault: true },
          { id: sharedSpace, organizationId: sharedOrg, name: "Theirs", isDefault: true },
          { id: importerSpace, organizationId: importerOrg, name: "General", isDefault: true },
        ],
      });
      // Members join each organization's default space by trigger.
      await prisma.member.createMany({
        data: [
          { org: personalOrg, user: exporter },
          { org: sharedOrg, user: other },
          { org: sharedOrg, user: exporter },
          { org: importerOrg, user: importer },
        ].map(({ org, user }) => ({
          id: `${org}-${user}`,
          organizationId: org,
          userId: user,
          role: "owner",
          createdAt: now,
        })),
      });
      await prisma.spaceMember.updateMany({
        where: { spaceId: sharedSpace, userId: exporter },
        data: { role: "member" },
      });
      await prisma.spaceMember.updateMany({
        where: { spaceId: ownedSpace, userId: exporter },
        data: { role: "owner" },
      });
      await prisma.spaceMember.updateMany({
        where: { spaceId: sharedSpace, userId: other },
        data: { role: "owner" },
      });

      const bot = (id: string, spaceId: string, userId: string) =>
        prisma.bot.create({
          data: { id, spaceId, userId, name: id, color: "blue" },
        });
      await bot(`mine-${suffix}`, ownedSpace, exporter);
      await bot(`mine-shared-${suffix}`, sharedSpace, exporter);
      await bot(`theirs-${suffix}`, sharedSpace, other);
      const thread = await prisma.thread.create({
        data: {
          spaceId: ownedSpace,
          userId: exporter,
          botId: `mine-${suffix}`,
          historyCompactionSummary: "Summary mentions PERIWINKLE",
        },
      });
      await createThreadMessage(prisma, {
        threadId: thread.id,
        role: "user",
        blocks: [{ kind: "text", text: "The codeword is MARIGOLD" }],
      });
      await createThreadMessage(prisma, {
        threadId: thread.id,
        role: "assistant",
        botId: `mine-${suffix}`,
        blocks: [{ kind: "text", text: "Noted" }],
      });
      const theirThread = await prisma.thread.create({
        data: { spaceId: sharedSpace, userId: other, botId: `theirs-${suffix}` },
      });
      await createThreadMessage(prisma, {
        threadId: theirThread.id,
        role: "user",
        blocks: [{ kind: "text", text: "Private to someone else" }],
      });
      const document = await prisma.memoryDocument.create({
        data: {
          spaceId: ownedSpace,
          userId: exporter,
          scope: "user",
          path: "notes.md",
          content: "Remember TANGERINE",
        },
      });
      await prisma.memoryRevision.create({
        data: { documentId: document.id, revision: 1, content: "Remember TANGERINE" },
      });
      await prisma.memoryDocument.create({
        data: {
          spaceId: sharedSpace,
          userId: other,
          scope: "user",
          path: "theirs.md",
          content: "Not yours",
        },
      });
      const root = await prisma.artifact.create({
        data: {
          spaceId: ownedSpace,
          userId: exporter,
          botId: `mine-${suffix}`,
          name: "plan.txt",
          mimeType: "text/plain",
          size: 4,
          hash: "hash-1",
          storageKey: `blob-1-${suffix}`,
        },
      });
      await prisma.artifact.create({
        data: {
          spaceId: ownedSpace,
          userId: exporter,
          botId: `mine-${suffix}`,
          name: "plan.txt",
          mimeType: "text/plain",
          size: 4,
          hash: "hash-2",
          storageKey: `blob-2-${suffix}`,
          rootArtifactId: root.id,
          version: 2,
        },
      });
      await prisma.agentSkill.createMany({
        data: [
          { spaceId: ownedSpace, userId: exporter, name: "Mine", description: "", content: "x" },
          {
            spaceId: ownedSpace,
            userId: exporter,
            name: "Builtin",
            description: "",
            content: "x",
            source: "builtin",
          },
        ],
      });
      for (const spaceId of [ownedSpace, sharedSpace]) {
        const board = await prisma.board.create({ data: { spaceId, name: `Board ${spaceId}` } });
        const ticket = await prisma.ticket.create({
          data: {
            boardId: board.id,
            spaceId,
            number: 1,
            title: `Ticket in ${spaceId}`,
            assigneeBotId: spaceId === ownedSpace ? `mine-${suffix}` : `theirs-${suffix}`,
            createdByUserId: spaceId === ownedSpace ? exporter : other,
          },
        });
        await prisma.ticketComment.create({
          data: { ticketId: ticket.id, spaceId, authorUserId: exporter, body: "Looks good" },
        });
      }
    }),
  );

  afterAll(async () => {
    if (!db) return;
    await runAsSystem("test fixture", async () => {
      await prisma.organization.deleteMany({
        where: { id: { in: [personalOrg, sharedOrg, importerOrg] } },
      });
      await prisma.user.deleteMany({ where: { id: { in: [exporter, other, importer] } } });
    });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("downloads only the exporter's content, decrypted", async () => {
    const app = new Hono();
    mountAccountExportRoute(app, {
      prisma,
      auth: { consumeAccountExportToken: async (token) => (token === "good" ? exporter : null) },
      artifacts: { get: async (key) => new TextEncoder().encode(`bytes:${key}`) },
      home: { exportHome: async function* () {} },
    });
    const response = await app.request("/api/account/export?token=good");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="rakazo-export-\d{4}-\d{2}-\d{2}\.zip"$/,
    );
    const entries = unzipSync(new Uint8Array(await response.arrayBuffer()));
    const decode = (path: string) => new TextDecoder().decode(entries[path]);
    const manifest = AccountExportManifestSchema.parse(JSON.parse(decode("manifest.json")));
    expect(manifest.spaces.map((space) => space.id).sort()).toEqual(
      [ownedSpace, sharedSpace].sort(),
    );
    const records = (spaceId: string): AccountExportRecord[] =>
      decode(accountExportPaths.records(spaceId))
        .trimEnd()
        .split("\n")
        .filter(Boolean)
        .map((line) => AccountExportRecordSchema.parse(JSON.parse(line)));

    const owned = records(ownedSpace);
    expect(owned.map((record) => record.type)).toEqual([
      "bot",
      "thread",
      "message",
      "message",
      "artifact",
      "artifact",
      "memory_document",
      "memory_revision",
      "agent_skill",
      "board",
      "ticket",
      "ticket_comment",
    ]);
    const owns = <T extends AccountExportRecord["type"]>(type: T) =>
      owned.filter(
        (record): record is Extract<AccountExportRecord, { type: T }> => record.type === type,
      );
    expect(owns("thread")[0]!.historyCompactionSummary).toBe("Summary mentions PERIWINKLE");
    expect(owns("message")[0]!.blocks).toEqual([
      { kind: "text", text: "The codeword is MARIGOLD" },
    ]);
    expect(owns("memory_document")[0]!.content).toBe("Remember TANGERINE");
    expect(owns("memory_revision")[0]!.content).toBe("Remember TANGERINE");
    expect(owns("artifact").map((artifact) => artifact.version)).toEqual([1, 2]);
    expect(owns("ticket")[0]).toMatchObject({
      assigneeBotId: `mine-${suffix}`,
      createdByExporter: true,
    });
    for (const artifact of owns("artifact"))
      expect(entries[accountExportPaths.artifact(ownedSpace, artifact.id)]).toBeDefined();
    const rawBlocks = await db.pool.query<{ blocks: string }>(
      'SELECT blocks::text AS blocks FROM messages WHERE "threadId" = $1',
      [owns("thread")[0]!.id],
    );
    expect(rawBlocks.rows.map((row) => row.blocks).join()).not.toContain("MARIGOLD");

    const shared = records(sharedSpace);
    expect(shared).toEqual([expect.objectContaining({ type: "bot", id: `mine-shared-${suffix}` })]);
    expect(decode(accountExportPaths.records(sharedSpace))).not.toContain(other);
  });

  it("lists only files whose records it wrote, even if one is saved meanwhile", async () => {
    const source = await readAccountExport(prisma, exporter);
    const owned = source.spaces.find((space) => space.id === ownedSpace)!;
    const written: string[] = [];
    for await (const record of owned.records())
      if (record.type === "artifact") written.push(record.id);
    const late = await runAsSystem("test fixture", () =>
      prisma.artifact.create({
        data: {
          spaceId: ownedSpace,
          userId: exporter,
          name: "late.txt",
          mimeType: "text/plain",
          size: 1,
          hash: "late",
          storageKey: `late-${suffix}`,
        },
      }),
    );
    try {
      const listed: string[] = [];
      for await (const artifact of owned.artifacts()) listed.push(artifact.id);
      expect(listed).toEqual(written);
      expect(listed).not.toContain(late.id);
    } finally {
      await runAsSystem("test fixture", () => prisma.artifact.delete({ where: { id: late.id } }));
    }
  });

  it("imports into another account with the same content", async () => {
    const blobs = new Map<string, Uint8Array>();
    const exportApp = new Hono();
    mountAccountExportRoute(exportApp, {
      prisma,
      auth: { consumeAccountExportToken: async (token) => token },
      artifacts: { get: async (key) => blobs.get(key) ?? new TextEncoder().encode(`bytes:${key}`) },
      home: { exportHome: async function* () {} },
    });
    const download = async (userId: string) =>
      new Uint8Array(
        await (await exportApp.request(`/api/account/export?token=${userId}`)).arrayBuffer(),
      );
    const archive = await download(exporter);

    const root = await mkdtemp(path.join(tmpdir(), "rakazo-account-roundtrip-"));
    const noop = new Proxy({}, { get: () => async () => undefined });
    const actor: Actor = {
      userId: importer,
      spaceId: importerSpace,
      email: `${importer}@rakazo.test`,
      isDeploymentOwner: false,
    };
    try {
      const result = await importAccount(
        {
          prisma,
          artifacts: {
            put: async ({ bytes }: { bytes: Uint8Array }) => {
              const id = `roundtrip-${blobs.size}-${suffix}`;
              blobs.set(id, bytes);
              return { id, hash: "" };
            },
            remove: async (id: string) => void blobs.delete(id),
          } as never,
          home: new LocalAgentHomeStore(root),
          sandbox: noop as SandboxProvider,
          jobs: noop as JobPublisher,
          dataDir: root,
          maxArtifactBytes: 1024 * 1024,
        },
        actor,
        (async function* () {
          yield archive;
        })(),
      );
      expect(result.spaces.map((space) => space.name).sort()).toEqual(["Mine", "Theirs"]);

      const records = (bytes: Uint8Array, spaceId: string) =>
        new TextDecoder()
          .decode(unzipSync(bytes)[accountExportPaths.records(spaceId)])
          .trimEnd()
          .split("\n")
          .filter(Boolean)
          .map((line) => AccountExportRecordSchema.parse(JSON.parse(line)));
      /** What a person sees: content and structure, not ids, owners or default rows. */
      const content = (list: AccountExportRecord[]) =>
        list.flatMap((record) => {
          switch (record.type) {
            case "bot":
              return [`bot ${record.name} ${record.instructions}`];
            case "thread":
              // Every imported bot gets its thread; the fixture's bots were inserted without one.
              return record.historyCompactionSummary
                ? [`thread ${record.historyCompactionSummary}`]
                : [];
            case "message":
              return [`message ${record.seq} ${record.role} ${JSON.stringify(record.blocks)}`];
            case "artifact":
              return [`artifact ${record.name} v${record.version}`];
            case "memory_document":
              return record.path === "notes.md" ? [`memory ${record.content}`] : [];
            case "memory_revision":
              return record.content.includes("TANGERINE") ? [`revision ${record.content}`] : [];
            case "agent_skill":
              return [`skill ${record.name}`];
            case "board":
              return [`board ${record.name}`];
            case "ticket":
              return [`ticket ${record.number} ${record.title} ${record.createdByExporter}`];
            case "ticket_comment":
              return [`comment ${record.body} ${record.authoredByExporter}`];
            default:
              return [];
          }
        });

      const again = await download(importer);
      const imported = new Map(result.spaces.map((space) => [space.name, space.id]));
      expect(content(records(again, imported.get("Mine")!))).toEqual(
        content(records(archive, ownedSpace)),
      );
      expect(content(records(again, imported.get("Theirs")!))).toEqual(
        content(records(archive, sharedSpace)),
      );
      const artifactBytes = (list: Uint8Array, spaceId: string) =>
        records(list, spaceId)
          .filter((record) => record.type === "artifact")
          .map((record) =>
            new TextDecoder().decode(
              unzipSync(list)[accountExportPaths.artifact(spaceId, record.id)],
            ),
          );
      expect(artifactBytes(again, imported.get("Mine")!)).toEqual(
        artifactBytes(archive, ownedSpace),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
