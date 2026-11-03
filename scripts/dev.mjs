#!/usr/bin/env node
// `pnpm dev`: start the API, worker, web app, and sandbox supervisor for this checkout.
//
// Several checkouts (git worktrees) can run at once. Each gets the first free block of ports,
// and all of them share one Postgres database unless this branch adds migrations that main
// does not have; those run against a database of the branch's own on the same server, so
// unmerged schema changes never reach the shared one.
//
// The database is `.env`'s DATABASE_URL when it accepts a connection. Otherwise a local
// Postgres container (`rakazo-dev-postgres`) is started and reused by every checkout.
// Setting WEB_PORT or API_PORT, in the shell or `.env`, turns off port selection. A relative
// DATA_DIR resolves in the main checkout, so checkouts sharing the database share its files.
// Branch databases, and their copied files, are dropped once the branch is deleted or merged.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants,
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPnpm, spawnPnpm } from "./pnpm.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbPackage = path.join(root, "packages/db");
const require = createRequire(path.join(dbPackage, "package.json"));
const { Client } = require("pg");
const dotenv = require("dotenv");

const DEFAULT_PORTS = { web: 5173, api: 3100, supervisor: 7091 };
const PORT_STEP = 10;
const MANAGED = {
  container: "rakazo-dev-postgres",
  image: "postgres:18",
  port: 54318,
  owner: "rakazo",
  runtime: "rakazo_dev",
  database: "rakazo",
};
const SERVICES = ["@rakazo/api", "@rakazo/worker", "@rakazo/web", "@rakazo/sandbox-supervisor"];

const fileEnv = existsSync(path.join(root, ".env"))
  ? dotenv.parse(readFileSync(path.join(root, ".env")))
  : {};
const setting = (name) => process.env[name] ?? fileEnv[name];
const log = (message) => process.stdout.write(`[dev] ${message}\n`);

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", stdio: "pipe", ...options }).trim();
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function choosePorts() {
  for (let block = 0; block < 50; block += 1) {
    const ports = Object.fromEntries(
      Object.entries(DEFAULT_PORTS).map(([name, port]) => [name, port + block * PORT_STEP]),
    );
    const free = await Promise.all(Object.values(ports).map(portFree));
    if (free.every(Boolean)) return ports;
  }
  throw new Error("No free port block found near the defaults. Set WEB_PORT and API_PORT in .env.");
}

function portEnv({ web, api, supervisor }) {
  const webUrl = `http://127.0.0.1:${web}`;
  const apiUrl = `http://127.0.0.1:${api}`;
  return {
    WEB_PORT: String(web),
    WEB_ORIGIN: webUrl,
    BETTER_AUTH_URL: webUrl,
    API_PORT: String(api),
    API_URL: apiUrl,
    API_PROXY_TARGET: apiUrl,
    SUPERVISOR_PORT: String(supervisor),
    SANDBOX_SUPERVISOR_URL: `http://127.0.0.1:${supervisor}`,
  };
}

async function connects(url) {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

function withDatabase(url, database) {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function startManagedPostgres() {
  try {
    run("docker", ["version", "--format", "{{.Server.Version}}"]);
  } catch {
    throw new Error(
      "DATABASE_URL in .env does not accept a connection and Docker is not running to start a local Postgres.",
    );
  }
  const state = (() => {
    try {
      return run("docker", ["inspect", "--format", "{{.State.Running}}", MANAGED.container]);
    } catch {
      return null;
    }
  })();
  if (state === null) {
    log(`Starting a shared Postgres container (${MANAGED.container})`);
    run("docker", [
      "run",
      "-d",
      "--name",
      MANAGED.container,
      "--restart",
      "unless-stopped",
      "-e",
      `POSTGRES_USER=${MANAGED.owner}`,
      // Development only: the container is published on loopback and holds throwaway data.
      "-e",
      `POSTGRES_PASSWORD=${MANAGED.owner}`,
      "-e",
      `POSTGRES_DB=${MANAGED.database}`,
      "-p",
      `127.0.0.1:${MANAGED.port}:5432`,
      "-v",
      `${MANAGED.container}:/var/lib/postgresql`,
      MANAGED.image,
    ]);
  } else if (state !== "true") {
    run("docker", ["start", MANAGED.container]);
  }
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      run("docker", ["exec", MANAGED.container, "pg_isready", "-q", "-U", MANAGED.owner]);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  const server = `127.0.0.1:${MANAGED.port}`;
  return {
    url: `postgres://${MANAGED.runtime}:${MANAGED.runtime}@${server}/${MANAGED.database}`,
    migrationUrl: `postgres://${MANAGED.owner}:${MANAGED.owner}@${server}/${MANAGED.database}`,
  };
}

async function sharedDatabase() {
  const url = setting("DATABASE_URL");
  const migrationUrl = setting("DATABASE_MIGRATION_URL") || url;
  if (url && (await connects(migrationUrl))) return { url, migrationUrl };
  if (url) log("DATABASE_URL in .env does not accept a connection; using the local container");
  return startManagedPostgres();
}

function migrationNames(ref) {
  return new Set(
    run("git", ["ls-tree", "--name-only", ref, "packages/db/prisma/migrations/"], { cwd: root })
      .split("\n")
      .filter(Boolean)
      .map((entry) => path.basename(entry)),
  );
}

function mainMigrations() {
  try {
    return migrationNames("origin/main");
  } catch {
    // Without main to compare against, any migration may be unmerged.
    throw new Error("Could not read origin/main. Run `git fetch origin main` and try again.");
  }
}

/** Migration folders in a checkout's working tree, committed or not. */
function checkoutMigrations(checkout) {
  const dir = path.join(checkout, "packages/db/prisma/migrations");
  if (!existsSync(dir)) return new Set();
  return new Set(readdirSync(dir).filter((name) => statSync(path.join(dir, name)).isDirectory()));
}

/** Migrations in this checkout that origin/main does not have. */
function branchOnlyMigrations(onMain) {
  return [...checkoutMigrations(root)].filter((name) => !onMain.has(name));
}

/** A branch's migrations: its worktree's files when it is checked out, else its commits. */
function branchMigrations(branch) {
  const worktrees = run("git", ["worktree", "list", "--porcelain"], { cwd: root }).split("\n\n");
  for (const entry of worktrees) {
    const lines = entry.split("\n");
    if (lines.includes(`branch refs/heads/${branch}`)) {
      return checkoutMigrations(lines[0].replace(/^worktree /, ""));
    }
  }
  try {
    return migrationNames(`refs/heads/${branch}`);
  } catch {
    return new Set(); // Deleted.
  }
}

// Marks a finished branch database and records which repository and branch own it.
const BRANCH_DATABASE_COMMENT = "rakazo dev branch: ";

function branchDatabaseComment(branch) {
  return BRANCH_DATABASE_COMMENT + JSON.stringify({ repo: repositoryId(), branch });
}

function repositoryId() {
  return path.resolve(root, run("git", ["rev-parse", "--git-common-dir"], { cwd: root }));
}

function currentBranch() {
  return run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root });
}

/** `<shared>_<branch>_<hash>`, within Postgres's 63-byte limit on names. */
function branchDatabaseName(sharedName, branch) {
  // Distinct branches can clean up to the same name; the hash keeps their databases apart.
  const hash = createHash("sha256").update(branch).digest("hex").slice(0, 8);
  const readable = branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const prefix = `${sharedName}_${readable}`.slice(0, 63 - hash.length - 1).replace(/_+$/, "");
  return `${prefix}_${hash}`;
}

/** A branch database's files, kept apart so deleting one never removes a file main still uses. */
function branchDataDir(sharedDataDir, name) {
  return path.join(path.dirname(sharedDataDir), ".rakazo-dev-branches", name, "data");
}

async function branchDatabase(shared, sharedDataDir) {
  const sharedName = new URL(shared.migrationUrl).pathname.slice(1);
  const branch = currentBranch();
  const name = branchDatabaseName(sharedName, branch);
  const dataDir = branchDataDir(sharedDataDir, name);
  const owner = new Client({ connectionString: shared.migrationUrl });
  await owner.connect();
  try {
    // Two starts of the same branch take turns; the lock ends with this connection.
    await owner.query("SELECT pg_advisory_lock(hashtext($1))", [name]);
    const existing = await owner.query(
      `SELECT shobj_description(oid, 'pg_database') AS comment FROM pg_database WHERE datname = $1`,
      [name],
    );
    if (existing.rowCount && existing.rows[0].comment)
      return branchConnection(shared, name, dataDir);
    // No comment means an earlier start stopped partway; begin again.
    if (existing.rowCount) await owner.query(`DROP DATABASE "${name}"`);
    rmSync(path.dirname(dataDir), { recursive: true, force: true });
    let copied = true;
    try {
      // A copy keeps your accounts and bots; it needs no open connections to the source.
      await owner.query(`CREATE DATABASE "${name}" TEMPLATE "${sharedName}"`);
    } catch {
      copied = false;
      await owner.query(`CREATE DATABASE "${name}"`);
    }
    try {
      if (copied && existsSync(sharedDataDir)) {
        // Copy-on-write where the filesystem supports it, so this is cheap even for large homes.
        cpSync(sharedDataDir, dataDir, { recursive: true, mode: constants.COPYFILE_FICLONE });
      }
    } catch (error) {
      await owner.query(`DROP DATABASE "${name}"`);
      rmSync(path.dirname(dataDir), { recursive: true, force: true });
      throw new Error(`Could not copy ${sharedDataDir} for ${name}`, { cause: error });
    }
    await owner.query(
      `COMMENT ON DATABASE "${name}" IS ${owner.escapeLiteral(branchDatabaseComment(branch))}`,
    );
    log(
      copied
        ? `Copied the shared database and files to ${name}`
        : `Created an empty ${name} (the shared one was in use, so it could not be copied)`,
    );
  } finally {
    await owner.end();
  }
  return branchConnection(shared, name, dataDir);
}

function branchConnection(shared, name, dataDir) {
  return {
    url: withDatabase(shared.url, name),
    migrationUrl: withDatabase(shared.migrationUrl, name),
    dataDir,
  };
}

/**
 * Drop this repository's branch databases that nothing needs anymore: the branch was deleted, or
 * main now has all of its migrations, counting uncommitted ones in a branch's worktree. `keep`, the
 * branch about to start, and any database another checkout still has open are left alone.
 */
async function pruneBranchDatabases(shared, sharedDataDir, onMain, keep) {
  const owner = new Client({ connectionString: shared.migrationUrl });
  await owner.connect();
  try {
    const { rows } = await owner.query(
      `SELECT d.datname AS name, substr(c.description, $2) AS owner
         FROM pg_database d JOIN pg_shdescription c ON c.objoid = d.oid
        WHERE c.description LIKE $1 || '%'`,
      [BRANCH_DATABASE_COMMENT, BRANCH_DATABASE_COMMENT.length + 1],
    );
    const repo = repositoryId();
    for (const row of rows) {
      let branch;
      try {
        const parsed = JSON.parse(row.owner);
        if (parsed.repo !== repo) continue;
        branch = parsed.branch;
      } catch {
        continue;
      }
      if (branch === keep) continue;
      if ([...branchMigrations(branch)].some((name) => !onMain.has(name))) continue;
      try {
        await owner.query(`DROP DATABASE "${row.name}"`);
        rmSync(path.dirname(branchDataDir(sharedDataDir, row.name)), {
          recursive: true,
          force: true,
        });
        log(`Removed ${row.name}; ${branch} no longer needs its own database`);
      } catch {
        // Still in use by a running checkout.
      }
    }
  } finally {
    await owner.end();
  }
}

function generateClientIfStale(env) {
  const client = path.join(dbPackage, "src/generated/prisma/client.ts");
  const schema = path.join(dbPackage, "prisma/schema.prisma");
  if (existsSync(client) && statSync(client).mtimeMs >= statSync(schema).mtimeMs) return;
  log("Generating the Prisma client");
  runPnpm(["--filter", "@rakazo/db", "generate"], {
    cwd: root,
    env,
    stdio: "inherit",
  });
}

const env = { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" };

let ports = null;
if (!setting("WEB_PORT") && !setting("API_PORT")) {
  ports = await choosePorts();
  Object.assign(env, portEnv(ports));
}

// Checkouts that share a database also share its job queue, so any checkout's worker may write a
// file another checkout's API reads. A relative DATA_DIR resolves in the main checkout for all.
const mainCheckout = path.dirname(
  path.resolve(root, run("git", ["rev-parse", "--git-common-dir"], { cwd: root })),
);
const sharedDataDir = path.resolve(mainCheckout, setting("DATA_DIR") || "./data");

const shared = { ...(await sharedDatabase()), dataDir: sharedDataDir };
let database = shared;
const onMain = mainMigrations();
const pending = branchOnlyMigrations(onMain);
await pruneBranchDatabases(shared, sharedDataDir, onMain, pending.length ? currentBranch() : null);
if (pending.length) {
  log(`This branch adds ${pending.length} migration(s), so it gets its own database`);
  database = await branchDatabase(shared, sharedDataDir);
}
env.DATABASE_URL = database.url;
env.DATABASE_MIGRATION_URL = database.migrationUrl;
env.DATA_DIR = database.dataDir;

generateClientIfStale(env);
// Checkouts starting together would otherwise grant the server-wide runtime role at the same
// moment and fail. Advisory locks are per database, so every checkout locks the shared one.
const migrationLock = new Client({ connectionString: shared.migrationUrl });
await migrationLock.connect();
try {
  await migrationLock.query("SELECT pg_advisory_lock(hashtext('rakazo dev migrate'))");
  runPnpm(["db:migrate"], { cwd: root, env, stdio: "inherit" });
} finally {
  await migrationLock.end();
}

if (ports) log(`Open http://127.0.0.1:${ports.web}`);
const turbo = spawnPnpm(
  ["exec", "turbo", "dev", "--env-mode=loose", ...SERVICES.map((name) => `--filter=${name}`)],
  { cwd: root, env, stdio: "inherit" },
);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => turbo.kill(signal));
turbo.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
