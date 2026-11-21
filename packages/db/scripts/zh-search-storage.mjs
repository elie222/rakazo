import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

// Use the in-memory PostgreSQL build bundled with the repo's Prisma dev tools.
const require = createRequire(import.meta.url);
const prismaRequire = createRequire(require.resolve("prisma/package.json"));
const prismaDevRequire = createRequire(prismaRequire.resolve("@prisma/dev"));
const { PGlite } = prismaDevRequire("@electric-sql/pglite");

// Pipe the comparison runner's --storage-tsv output into this script.
const input = readFileSync(0, "utf8").trim();
if (!input) throw new Error("Expected token rows on stdin");
const strategies = new Map();
for (const line of input.split(/\r?\n/)) {
  const [strategy, id, tokens] = line.split("\t");
  if (!strategy || !id || !tokens) throw new Error("Expected strategy, message ID and int[]");
  if (!strategies.has(strategy)) strategies.set(strategy, []);
  strategies.get(strategy).push([id, tokens]);
}

const db = new PGlite();
try {
  const {
    rows: [settings],
  } = await db.query(
    "SELECT current_setting('server_version') AS version, current_setting('block_size') AS block_bytes",
  );
  process.stdout.write(
    `PostgreSQL ${settings.version} (PGlite), block size ${settings.block_bytes} bytes\n`,
  );
  process.stdout.write(
    "strategy\tmessages\ttokens\tpayload_bytes\tstored_array_bytes\tgin_bytes\n",
  );
  for (const [strategy, messages] of strategies) {
    await db.exec("CREATE TEMP TABLE sample (id text PRIMARY KEY, tokens integer[] NOT NULL)");
    for (const row of messages) {
      await db.query("INSERT INTO sample (id, tokens) VALUES ($1, $2::integer[])", row);
    }
    // Build after inserting, so the GIN size describes a freshly built index.
    await db.exec("CREATE INDEX sample_gin ON sample USING gin (tokens)");
    const {
      rows: [size],
    } = await db.query(`
      SELECT count(*) AS messages, sum(cardinality(tokens)) AS tokens,
             sum(cardinality(tokens) * 4) AS payload_bytes,
             sum(pg_column_size(tokens)) AS stored_array_bytes,
             pg_relation_size('sample_gin') AS gin_bytes
      FROM sample
    `);
    const columns = [
      strategy,
      size.messages,
      size.tokens,
      size.payload_bytes,
      size.stored_array_bytes,
      size.gin_bytes,
    ];
    process.stdout.write(`${columns.join("\t")}\n`);
    await db.exec("DROP TABLE sample");
  }
} finally {
  await db.close();
}
