// `pnpm --filter @rakazo/api marketplace:seed [--publish]`: adds the starter bots the market
// does not have yet, as drafts for an operator to review, or published with --publish.
import { createDb, runAsSystem } from "@rakazo/db";
import { seedMarketplace } from "../bots/marketplace-seed.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const { prisma, pool } = createDb(url);
try {
  const publish = process.argv.includes("--publish");
  const added = await runAsSystem("marketplace starter listings", () =>
    seedMarketplace(prisma, { publish }),
  );
  process.stdout.write(
    added.length
      ? `Added ${added.length} ${publish ? "published" : "draft"} listing(s): ${added.join(", ")}\n`
      : "The market already has every starter listing; publish its drafts from the ops console.\n",
  );
} finally {
  await prisma.$disconnect();
  await pool.end();
}
