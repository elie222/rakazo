import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeIntegration = hasDb ? describe : describe.skip;

/**
 * Migration smoke guard for the autonomous-organization tables. The flagship
 * lifecycle test belongs beside this test and uses the same real Prisma URL.
 */
describeIntegration("organization PostgreSQL migration smoke", () => {
  let db: ReturnType<typeof createDb>;

  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
  });

  afterAll(async () => {
    await db?.prisma.$disconnect();
    await db?.pool.end();
  });

  it("exposes the autonomous organization persistence delegates after migrate deploy", async () => {
    await expect(
      Promise.all([
        db.prisma.employeeProfile.count(),
        db.prisma.companyGoal.count(),
        db.prisma.project.count(),
        db.prisma.workItem.count(),
        db.prisma.workItemExecution.count(),
        db.prisma.workItemReview.count(),
        db.prisma.managerEvaluation.count(),
        db.prisma.escalation.count(),
      ]),
    ).resolves.toHaveLength(8);
  });
});
