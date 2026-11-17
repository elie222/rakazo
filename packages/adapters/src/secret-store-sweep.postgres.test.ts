import { asSystem, createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { heldSecretRefs } from "./secret-store-sweep.js";

// Needs DATABASE_URL as the runtime login and DATABASE_MIGRATION_URL as the owner,
// as `pnpm test:integration` provides.
const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe
    : describe.skip;

describePostgres("secret store sweep (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `secret-sweep-user-${suffix}`;
  let owner: ReturnType<typeof createDb>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    owner = createDb(migrationUrl!);
    db = createDb(runtimeUrl!);
    await asSystem(owner.prisma).user.create({
      data: { id: userId, name: "Sweep", email: `${userId}@rakazo.test`, emailVerified: true },
    });
  });

  afterAll(async () => {
    if (!owner) return;
    await asSystem(owner.prisma).user.deleteMany({ where: { id: userId } });
    for (const handle of [owner, db]) {
      await handle.prisma.$disconnect();
      await handle.pool.end();
    }
  });

  it("finds refs in every column the store writes to, across every Space, as the runtime login", async () => {
    const fixture = asSystem(owner.prisma);
    const ref = (name: string) => `remote:sweep-${name}-${suffix}`;
    const [secret, wallet, unheld] = [ref("secret"), ref("wallet"), ref("unheld")];
    await fixture.secret.create({
      data: { id: `sweep-${suffix}`, userId, kind: "computer-provider", ciphertext: secret },
    });
    await fixture.paymentWallet.create({
      data: { userId, provider: "fake", status: "active", ciphertext: wallet },
    });

    const held = await heldSecretRefs(db.prisma, [secret, wallet, unheld]);
    expect([...held].sort()).toEqual([secret, wallet].sort());

    const columns = await db.prisma.$queryRaw<Array<{ name: string }>>`
      SELECT table_name || '.' || column_name AS name FROM information_schema.columns
      WHERE table_schema = current_schema() AND column_name ILIKE '%cipher%'`;
    expect(columns.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "secrets.ciphertext",
        "bot_secrets.ciphertext",
        "vault_credentials.ciphertext",
        "integration_provider_configs.ciphertext",
        "messaging_installations.ciphertext",
        "deployment_settings.computerProviderCipher",
        "payment_wallets.ciphertext",
        "purchases.cardCiphertext",
        "purchases.requestCiphertext",
        "purchases.tokenCiphertext",
      ]),
    );
  });
});
