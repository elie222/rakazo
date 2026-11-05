import { Client } from "pg";
import {
  readCaptureAdoptionSnapshot,
  validateCaptureAdoption,
} from "../turn-memory-capture-adoption.js";

try {
  const phase = process.argv[2];
  if (
    process.argv.length !== 3 ||
    (phase !== "before" && phase !== "prepared" && phase !== "resolved")
  ) {
    throw new Error("Usage: validate-capture-adoption.ts before|prepared|resolved");
  }
  const connectionString = process.env.DATABASE_MIGRATION_URL;
  if (!connectionString)
    throw new Error("Set DATABASE_MIGRATION_URL explicitly; no .env or runtime-login fallback");
  if (process.env.RAKAZO_MIGRATIONS_PATH)
    throw new Error("Unset RAKAZO_MIGRATIONS_PATH for this procedure");
  const url = new URL(connectionString);
  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    url.searchParams.getAll("schema").some((schema) => schema !== "public")
  ) {
    throw new Error("Only PostgreSQL with the public schema is supported");
  }
  if (url.searchParams.has("options"))
    throw new Error(
      "Remove URL options; this procedure uses the public schema without search_path overrides",
    );
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const state = validateCaptureAdoption(await readCaptureAdoptionSnapshot(client), phase);
    await client.query("COMMIT");
    process.stdout.write(`${phase}: verified; columns=${state.columns}, index=${state.index}\n`);
  } finally {
    await client.end();
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Adoption validation failed"}\n`,
  );
  process.exitCode = 1;
}
