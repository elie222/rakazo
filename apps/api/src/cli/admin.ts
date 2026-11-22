// Operator-only: admin.js <command> [--json]. Runs with shell access to the server; it opens no listener.
import {
  contentKeyProviderFromEnv,
  createSecretStore,
  unwrapEnvFromKeyManager,
  withSecretPersistence,
} from "@rakazo/adapters";
import { ClientError } from "@rakazo/core";
import {
  createDb,
  installAuditEventStore,
  installSecurityEventStore,
  runAsSystem,
} from "@rakazo/db";
import { loadEnv } from "../env.js";
import { AdminCommandError } from "./admin/admin-command.js";
import { ADMIN_USAGE, formatAdminResult, parseAdminArgs } from "./admin/commands.js";

const invocation = parseAdminArgs(process.argv.slice(2));
if (!invocation) {
  process.stderr.write(ADMIN_USAGE);
  process.exit(2);
}

await unwrapEnvFromKeyManager();
const env = loadEnv();
const db = createDb(env.databaseUrl, {
  keyProvider: contentKeyProviderFromEnv(),
  encryptContent: env.contentEncryption,
});
const secrets = createSecretStore(env.encryptionKey);
await secrets.start();
const prisma = withSecretPersistence(db.prisma, secrets);
installSecurityEventStore(prisma);
installAuditEventStore(prisma);
try {
  const result = await runAsSystem("run an operator admin command", () =>
    invocation.run({
      prisma,
      secrets,
      env,
      pool: db.pool,
      apiUrl: env.apiUrl,
      inboundOrigin: env.publishedInboundOrigin,
      signal: new AbortController().signal,
    }),
  );
  process.stdout.write(formatAdminResult(result, invocation.json));
} catch (error) {
  if (!(error instanceof AdminCommandError || error instanceof ClientError)) throw error;
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  await secrets.close();
  await db.prisma.$disconnect();
  await db.pool.end();
}
