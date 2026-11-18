import type { ArtifactStore } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, runAsSystem, runAsTenant } from "@rakazo/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createOwnedArtifact, storeInboundAttachment } from "./artifacts.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("artifact computer paths (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `computer-path-user-${suffix}`;
  const organizationId = `computer-path-org-${suffix}`;
  const spaceId = `computer-path-space-${suffix}`;
  const actor: Actor = {
    userId,
    spaceId,
    email: `${userId}@rakazo.test`,
    isDeploymentOwner: false,
  };
  const attachmentNaming = { names: "readable", folders: "month" } as const;
  let puts = 0;
  const artifacts = {
    async put() {
      puts += 1;
      return { id: `blob-${puts}` };
    },
    async remove() {},
  } as unknown as ArtifactStore;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let botId: string;
  const pathOf = async (id: string) =>
    (await system.artifact.findUniqueOrThrow({ where: { id }, select: { computerPath: true } }))
      .computerPath;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    await system.user.create({
      data: {
        id: userId,
        name: "Dana",
        email: `${userId}@rakazo.test`,
        emailVerified: false,
        timezone: "Asia/Jerusalem",
      },
    });
    await system.organization.create({
      data: { id: organizationId, name: "Path Org", slug: organizationId, createdAt: new Date() },
    });
    await system.space.create({
      data: { id: spaceId, organizationId, name: "General", isDefault: true },
    });
    botId = (await system.bot.create({ data: { spaceId, userId, name: "Chief", color: "blue" } }))
      .id;
  });

  beforeEach(() => {
    // Every file of a test arrives in the same minute: 16:49 in Jerusalem.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-18T14:49:30.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    if (!prisma) return;
    await system.organization.deleteMany({ where: { id: organizationId } });
    await system.user.deleteMany({ where: { id: userId } });
    await close();
  });

  it("gives same-name files from one sender in one minute their own paths", async () => {
    const stored = await Promise.all(
      [0, 1, 2].map((index) =>
        runAsTenant(actor, () =>
          storeInboundAttachment({ prisma, artifacts, attachmentNaming }, actor, {
            botId,
            attachment: {
              name: "video.mp4",
              mimeType: "video/mp4",
              fetch: async () => new Uint8Array([index + 1]),
            },
            clientNonce: `chat-video:${index}`,
            sender: "+972 50 555 0100",
          }),
        ),
      ),
    );
    const paths = await Promise.all(stored.map((artifact) => pathOf(artifact.id)));
    expect(paths.sort()).toEqual([
      "attachments/2026/11/2026-11-18_1649_+972 50 555 0100_video-2.mp4",
      "attachments/2026/11/2026-11-18_1649_+972 50 555 0100_video-3.mp4",
      "attachments/2026/11/2026-11-18_1649_+972 50 555 0100_video.mp4",
    ]);
  });

  // Chat-app and email files are stored under the system context their webhook runs in.
  it.each([
    ["messaging inbound", "chat.pdf"],
    ["inbound email", "mail.pdf"],
  ])("dates a file stored under %s in the owner's time zone", async (reason, name) => {
    const stored = await runAsSystem(reason, () =>
      storeInboundAttachment({ prisma, artifacts, attachmentNaming }, actor, {
        botId,
        attachment: { name, mimeType: "application/pdf", fetch: async () => new Uint8Array([1]) },
        clientNonce: `system-file:${name}`,
        sender: "Noa",
      }),
    );
    expect(await pathOf(stored.id)).toBe(`attachments/2026/11/2026-11-18_1649_Noa_${name}`);
  });

  it("returns the same row and path for a replayed upload", async () => {
    const upload = () =>
      runAsTenant(actor, () =>
        createOwnedArtifact({ prisma, artifacts, attachmentNaming }, actor, {
          botId,
          name: "photo.png",
          mimeType: "image/png",
          contentBase64: Buffer.from("png").toString("base64"),
          clientNonce: "upload-1:0",
        }),
      );
    const first = await upload();
    const replay = await upload();
    expect(replay).toEqual(first);
    expect(await pathOf(first.id)).toBe("attachments/2026/11/2026-11-18_1649_Dana_photo.png");
    expect(await system.artifact.count({ where: { spaceId, clientNonce: "upload-1:0" } })).toBe(1);
  });
});
