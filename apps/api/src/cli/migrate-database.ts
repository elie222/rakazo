// `pnpm db:migrate`: schema migrations, the job queue schema, then the runtime
// login. Everything here runs as the migration (owner) role; the API and worker
// then connect with DATABASE_URL and only get the runtime grants.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrateJobQueue, unwrapEnvFromKeyManager } from "@rakazo/adapters";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import {
  databaseUrls,
  deployMigrations,
  provisionRuntimeRole,
  RUNTIME_ROLE,
  SINGLE_DATABASE_URL_WARNING,
} from "@rakazo/db";

loadRootEnv();
await unwrapEnvFromKeyManager();
const urls = databaseUrls(process.env);
// In a checkout, this file (source or built) sits four folders below the root, next to packages/db.
// Finding the folder directly also works on Windows, where pnpm has no `pwd` to run.
const sourceDbPackageDir = fileURLToPath(new URL("../../../../packages/db/", import.meta.url));
await deployMigrations({
  migrationUrl: urls.migrationUrl,
  previousMigrations: process.env.RAKAZO_DEPLOYED_MIGRATIONS?.split(","),
  // A packaged server has no pnpm, so it names the database package's folder itself.
  dbPackageDir: process.env.RAKAZO_DB_PACKAGE_DIR
    ? path.resolve(process.env.RAKAZO_DB_PACKAGE_DIR)
    : existsSync(path.join(sourceDbPackageDir, "prisma", "migrations"))
      ? sourceDbPackageDir
      : execFileSync("pnpm", ["--filter", "@rakazo/db", "exec", "pwd"], {
          encoding: "utf8",
        }).trim(),
});
await migrateJobQueue(urls.migrationUrl);

if (!urls.separate) {
  process.stderr.write(`WARNING: ${SINGLE_DATABASE_URL_WARNING}\n`);
} else {
  const { warning } = await provisionRuntimeRole(urls.migrationUrl, urls.url);
  if (warning) process.stderr.write(`WARNING: ${warning}\n`);
  else process.stdout.write(`Runtime login is ready (member of ${RUNTIME_ROLE}).\n`);
}
