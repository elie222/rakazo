import { randomUUID } from "node:crypto";
import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { allocateTicketNumber, createDb, ensureBoard, runAsSystem, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

// The runtime login, so row-level security applies exactly as it does in a deployment.
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled).sequential("board prefix rename (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let actor: Actor;
  let boardId: string;
  const suffix = randomUUID().slice(0, 8);
  const organizationId = `board-rename-org-${suffix}`;
  const userId = `board-rename-user-${suffix}`;
  const spaceId = `board-rename-space-${suffix}`;

  const client = () =>
    createRouterClient(
      createRouter({
        prisma,
        env: { ticketBoardEnabled: true },
      } as unknown as RouterDeps),
      { context: { actor } },
    );

  beforeAll(() =>
    runAsSystem("board rename fixture", async () => {
      db = createDb(process.env.DATABASE_URL!);
      prisma = db.prisma;
      await prisma.user.create({
        data: {
          id: userId,
          name: "Board rename",
          email: `${userId}@rakazo.test`,
          emailVerified: false,
        },
      });
      await prisma.organization.create({
        data: {
          id: organizationId,
          name: "Board rename",
          slug: organizationId,
          createdAt: new Date(),
        },
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
      const board = await ensureBoard(prisma, spaceId);
      expect(board.nextNumber).toBe(1);
      boardId = board.id;
      actor = { spaceId, userId, email: `${userId}@rakazo.test`, isDeploymentOwner: false };
    }),
  );

  afterAll(() =>
    runAsSystem("board rename cleanup", async () => {
      if (!prisma) return;
      await prisma.organization.deleteMany({ where: { id: organizationId } });
      await prisma.user.deleteMany({ where: { id: userId } });
      await prisma.$disconnect();
      await db.pool.end();
    }),
  );

  it("rejects a prefix change that loses the race with the first ticket create", async () => {
    // createTicket allocates its number by incrementing this board row inside
    // the insert transaction. Hold that transaction open on a deferred to
    // reproduce the production interleaving the conditional update must beat.
    let signalInserted!: () => void;
    const ticketInserted = new Promise<void>((resolve) => {
      signalInserted = resolve;
    });
    let releaseCreator!: () => void;
    const hold = new Promise<void>((resolve) => {
      releaseCreator = resolve;
    });
    const creator = runAsTenant(actor, () =>
      prisma.$transaction(
        async (tx) => {
          const number = await allocateTicketNumber(tx, boardId);
          await tx.ticket.create({
            data: {
              boardId,
              spaceId,
              number,
              title: "First ticket",
              priority: "normal",
              assigneeBotId: null,
              createdByBotId: null,
              createdByUserId: userId,
            },
          });
          signalInserted();
          await hold;
        },
        { timeout: 20_000 },
      ),
    );
    try {
      await ticketInserted;

      const rename = client().boards.rename({ name: "Launch", ticketPrefix: "OPS" });

      // Deterministically wait for the rename's update to sit on the board
      // row lock the creator holds: an ungranted lock request in this database.
      const deadline = Date.now() + 5_000;
      for (;;) {
        const { rows } = await db.pool.query<{ blocked: number }>(
          `SELECT count(*)::int AS blocked
               FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
              WHERE a.datname = current_database() AND NOT l.granted`,
        );
        if (rows[0]!.blocked > 0) break;
        if (Date.now() > deadline) throw new Error("rename never blocked on the board row lock");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      releaseCreator();
      await creator;

      await expect(rename).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "Cannot change the ticket prefix once tickets exist.",
      });

      const board = await runAsSystem("board rename assertion", () =>
        prisma.board.findUniqueOrThrow({ where: { id: boardId } }),
      );
      expect(board.name).toBe("General");
      expect(board.ticketPrefix).toBe("RAK");
      expect(board.nextNumber).toBe(2);
      expect(
        await runAsSystem("board rename assertion", () =>
          prisma.ticket.count({ where: { boardId } }),
        ),
      ).toBe(1);
    } finally {
      releaseCreator();
      await creator.catch(() => undefined);
    }
  }, 15_000);
});
