import { EncryptedSecretStore, LocalArtifactStore, upgradeLegacySecrets } from "@rakazo/adapters";
import { resolveEncryptionKey } from "@rakazo/core";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import type { ContentMigrationMode } from "@rakazo/db";
import {
  contentEncryptionStatus,
  createDb,
  migrateContent,
  rewrapSpaceKeys,
  rotateSpaceDataKeys,
  runAsSystem,
} from "@rakazo/db";
import { createSecretMigrationRepository } from "../secret-migration.js";

loadRootEnv();

const USAGE = `Usage: content-encryption <command> [--dry-run]
  status               Rows and artifacts still in plaintext, keys per master key
  migrate              Encrypt existing content and upgrade legacy credentials
  rotate [--reencrypt] Re-wrap space keys under the active master key; with
                       --reencrypt also add new data keys and re-encrypt content
  reencrypt            Re-encrypt content still under an older data key
  decrypt              Write plaintext back before rolling back to an older release`;

const [command, ...flags] = process.argv.slice(2);
const commands = ["status", "migrate", "rotate", "reencrypt", "decrypt"];
if (
  !command ||
  !commands.includes(command) ||
  flags.some((flag) => !["--dry-run", "--reencrypt"].includes(flag)) ||
  (flags.includes("--reencrypt") && command !== "rotate")
) {
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}
const dryRun = flags.includes("--dry-run");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const { prisma, pool, contentKeys } = createDb(process.env.DATABASE_URL, {
  applicationName: "rakazo-content-encryption",
});
const artifacts = new LocalArtifactStore(process.env.DATA_DIR ?? "./data", contentKeys);
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
const write = (line: string) => process.stdout.write(`${line}\n`);

async function rewriteContent(mode: ContentMigrationMode) {
  if (!(await artifacts.hasDirectory()))
    write("artifacts: no artifact directory under DATA_DIR; files were not checked");
  else if (!dryRun) {
    const removed = await artifacts.removeAbandoned();
    if (removed) write(`artifacts: removed ${removed} temporary files left by an interrupted run`);
  }
  for (const table of await migrateContent(prisma, {
    mode,
    dryRun,
    signal: controller.signal,
  }))
    write(
      `${table.table}: ${table.updated} of ${table.scanned} ${dryRun ? "to rewrite" : "rewritten"}`,
    );
  let files = 0;
  let rewritten = 0;
  for await (const file of artifacts.files()) {
    controller.signal.throwIfAborted();
    files += 1;
    try {
      if (dryRun) continue;
      if ((await artifacts.rewriteFile(file.spaceId, file.id, mode)) === "rewritten")
        rewritten += 1;
    } catch {
      write(`artifact ${file.spaceId}/${file.id}: failed`);
      process.exitCode = 1;
    }
  }
  write(`artifacts: ${dryRun ? "not checked in a dry run" : `${rewritten} of ${files} rewritten`}`);
}

async function upgradeCredentials() {
  const counts = await upgradeLegacySecrets(
    createSecretMigrationRepository(prisma),
    new EncryptedSecretStore(resolveEncryptionKey(process.env)),
    {
      operationId: "content-encryption",
      traceId: "content-encryption",
      userId: "migration",
      spaceId: "migration",
      signal: controller.signal,
    },
    { dryRun, report: (row, status) => write(`credential ${row.label} ${row.id}: ${status}`) },
  );
  write(
    `credentials: ${counts.migrated} upgraded, ${counts.planned} planned, ${counts.verified} current, ${counts.concurrent} changed concurrently, ${counts.failed} failed`,
  );
  if (counts.failed) process.exitCode = 1;
}

// Rewrites every tenant's content, so it runs across Spaces.
try {
  await runAsSystem("content encryption maintenance", async () => {
    if (command === "status") {
      const status = await contentEncryptionStatus(prisma);
      for (const table of status.tables)
        write(`${table.table}: ${table.plaintext} of ${table.rows} in plaintext`);
      for (const [masterKeyId, count] of Object.entries(status.masterKeys))
        write(`space keys under master key ${masterKeyId}: ${count}`);
      write(`active master key: ${contentKeys.provider.activeKeyId()}`);
      const files = await artifacts.fileCounts();
      write(
        files.present
          ? `artifacts: ${files.plaintext} of ${files.plaintext + files.sealed} in plaintext${
              files.abandoned
                ? `, ${files.abandoned} temporary files from an interrupted run (migrate removes them)`
                : ""
            }`
          : "artifacts: no artifact directory under DATA_DIR; run where the data volume is mounted",
      );
    } else if (command === "migrate") {
      await rewriteContent("encrypt");
      await upgradeCredentials();
    } else if (command === "rotate") {
      const keys = await rewrapSpaceKeys(prisma, contentKeys, {
        dryRun,
        signal: controller.signal,
      });
      write(`space keys: ${keys.rewrapped} re-wrapped, ${keys.current} already current`);
      if (flags.includes("--reencrypt") && !dryRun) {
        write(
          `data keys: ${await rotateSpaceDataKeys(prisma, contentKeys, { signal: controller.signal })} spaces rotated`,
        );
        await rewriteContent("reencrypt");
      }
    } else if (command === "reencrypt") {
      await rewriteContent("reencrypt");
    } else {
      await rewriteContent("decrypt");
    }
  });
} catch (error) {
  process.stderr.write(
    `content-encryption ${command} failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exitCode = 1;
} finally {
  await prisma.$disconnect().catch(() => undefined);
  await pool.end().catch(() => undefined);
}
