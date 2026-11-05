import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import type { Client } from "pg";

const TARGET = "20261201120000_turn_memory_capture";
const TARGET_CHECKSUM = "1e384c600b8a3688e60f7b5096015ca01e8e535ca469a180429645d914ea2bed";
const migrationsDir = new URL("../prisma/migrations/", import.meta.url);
const indexDefinition =
  'CREATE INDEX "runs_memoryCaptureDueAt_memoryCapturedAt_idx" ON public.runs USING btree ("memoryCaptureDueAt", "memoryCapturedAt")';
const columnTypes = new Map([
  ["memoryCaptureDueAt", "timestamp(3) without time zone"],
  ["memoryCapturedAt", "timestamp(3) without time zone"],
  ["memoryRecallIds", "jsonb"],
]);

export type CaptureAdoptionPhase = "before" | "prepared" | "resolved";
export interface CaptureAdoptionSnapshot {
  tables: { name: string; kind: string }[];
  history: {
    migration_name: string;
    checksum: string;
    finished_at: Date | string | null;
    rolled_back_at: Date | string | null;
  }[];
  columns: {
    name: string;
    type: string;
    not_null: boolean;
    has_default: boolean;
    identity: string;
    generated: string;
  }[];
  indexes: { definition: string; valid: boolean; ready: boolean; live: boolean }[];
}

/** Narrow, read-only guard for the documented public-schema, first-adoption procedure. */
export function validateCaptureAdoption(
  state: CaptureAdoptionSnapshot,
  phase: CaptureAdoptionPhase,
) {
  for (const name of ["runs", "_prisma_migrations"]) {
    if (!state.tables.some((table) => table.name === name && table.kind === "r")) {
      throw new Error(`Requires ordinary public.${name}; no partitioned tables or baselining`);
    }
  }
  const expected = new Map(
    readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name <= TARGET)
      .map((entry) => [
        entry.name,
        createHash("sha256")
          .update(readFileSync(new URL(`${entry.name}/migration.sql`, migrationsDir)))
          .digest("hex"),
      ]),
  );
  if (expected.get(TARGET) !== TARGET_CHECKSUM)
    throw new Error("Original migration checksum changed");
  const finished = new Set<string>();
  for (const row of state.history) {
    const name = row.migration_name;
    if (!expected.has(name) || (name === TARGET && phase !== "resolved")) {
      throw new Error(`Not first adoption: unexpected or already recorded migration ${name}`);
    }
    if (row.rolled_back_at !== null) continue;
    if (row.finished_at === null)
      throw new Error(`Unfinished migration ${name}; stop and investigate`);
    if (finished.has(name)) throw new Error(`Duplicate applied migration ${name}`);
    if (row.checksum !== expected.get(name))
      throw new Error(`Applied migration checksum differs: ${name}`);
    finished.add(name);
  }
  for (const name of expected.keys()) {
    if (name < TARGET && !finished.has(name))
      throw new Error(`Missing applied predecessor ${name}`);
  }
  if (phase === "resolved" && !finished.has(TARGET))
    throw new Error("Target has not been resolved");

  // A successful columns-only preapply is resumable; partial or drifted DDL is not.
  if (
    state.columns.length &&
    (state.columns.length !== columnTypes.size ||
      state.columns.some(
        (column) =>
          columnTypes.get(column.name) !== column.type ||
          column.not_null ||
          column.has_default ||
          column.identity !== "" ||
          column.generated !== "",
      ))
  )
    throw new Error("Capture columns differ from the original migration; do not resolve");
  const columns = state.columns.length === columnTypes.size;
  if (
    state.indexes.length &&
    (state.indexes.length !== 1 ||
      state.indexes.some(
        (index) =>
          !index.valid || !index.ready || !index.live || index.definition !== indexDefinition,
      ))
  )
    throw new Error(
      "Legacy index is invalid, incomplete or has a different definition; do not resolve",
    );
  const index = state.indexes.length === 1;
  if (index && !columns) throw new Error("Legacy index exists without the capture columns");
  if (phase !== "before" && (!columns || !index))
    throw new Error("Capture columns and legacy index must exist before resolve");
  return { columns, index };
}

/** All lookups are schema-qualified; no DDL or Prisma-history writes are performed here. */
export async function readCaptureAdoptionSnapshot(
  client: Client,
): Promise<CaptureAdoptionSnapshot> {
  const { rows: tables } = await client.query<CaptureAdoptionSnapshot["tables"][number]>(`
    SELECT c.relname AS name, c.relkind AS kind
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname IN ('runs', '_prisma_migrations')
  `);
  // Refuse missing/wrong tables before querying their contents.
  if (tables.length !== 2 || tables.some((table) => table.kind !== "r")) {
    throw new Error("Requires ordinary public.runs and public._prisma_migrations");
  }
  const { rows: history } = await client.query<CaptureAdoptionSnapshot["history"][number]>(`
    SELECT migration_name, checksum, finished_at, rolled_back_at FROM public._prisma_migrations
    ORDER BY started_at, id
  `);
  const { rows: columns } = await client.query<CaptureAdoptionSnapshot["columns"][number]>(`
    SELECT attname AS name, pg_catalog.format_type(atttypid, atttypmod) AS type,
           attnotnull AS not_null, atthasdef AS has_default, attidentity AS identity, attgenerated AS generated
    FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.runs'::regclass AND NOT attisdropped AND attnum > 0
      AND attname IN ('memoryCaptureDueAt', 'memoryCapturedAt', 'memoryRecallIds')
  `);
  const { rows: indexes } = await client.query<CaptureAdoptionSnapshot["indexes"][number]>(`
    SELECT COALESCE(pg_catalog.pg_get_indexdef(c.oid), '') AS definition,
           COALESCE(i.indisvalid, false) AS valid, COALESCE(i.indisready, false) AS ready,
           COALESCE(i.indislive, false) AS live
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_catalog.pg_index i ON i.indexrelid = c.oid
    WHERE n.nspname = 'public' AND c.relname = 'runs_memoryCaptureDueAt_memoryCapturedAt_idx'
  `);
  return { tables, history, columns, indexes };
}
