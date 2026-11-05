import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CaptureAdoptionSnapshot } from "./turn-memory-capture-adoption.js";
import { validateCaptureAdoption } from "./turn-memory-capture-adoption.js";

const target = "20261201120000_turn_memory_capture";
const dir = new URL("../prisma/migrations/", import.meta.url);
const checksum = (name: string) =>
  createHash("sha256")
    .update(readFileSync(new URL(`${name}/migration.sql`, dir)))
    .digest("hex");

function snapshot(): CaptureAdoptionSnapshot {
  return {
    tables: [
      { name: "runs", kind: "r" },
      { name: "_prisma_migrations", kind: "r" },
    ],
    history: readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name < target)
      .map((entry) => ({
        migration_name: entry.name,
        checksum: checksum(entry.name),
        finished_at: "2026-01-01",
        rolled_back_at: null,
      })),
    columns: [],
    indexes: [],
  };
}

function prepared(): CaptureAdoptionSnapshot {
  return {
    ...snapshot(),
    columns: [
      {
        name: "memoryCaptureDueAt",
        type: "timestamp(3) without time zone",
        not_null: false,
        has_default: false,
        identity: "",
        generated: "",
      },
      {
        name: "memoryCapturedAt",
        type: "timestamp(3) without time zone",
        not_null: false,
        has_default: false,
        identity: "",
        generated: "",
      },
      {
        name: "memoryRecallIds",
        type: "jsonb",
        not_null: false,
        has_default: false,
        identity: "",
        generated: "",
      },
    ],
    indexes: [
      {
        valid: true,
        ready: true,
        live: true,
        definition:
          'CREATE INDEX "runs_memoryCaptureDueAt_memoryCapturedAt_idx" ON public.runs USING btree ("memoryCaptureDueAt", "memoryCapturedAt")',
      },
    ],
  };
}

describe("first capture migration adoption validation", () => {
  it("accepts only a complete, checksum-matched predecessor history before preapply", () => {
    expect(validateCaptureAdoption(snapshot(), "before")).toEqual({ columns: false, index: false });
    const missing = snapshot();
    missing.history.pop();
    expect(() => validateCaptureAdoption(missing, "before")).toThrow(/predecessor/);
    const drifted = snapshot();
    drifted.history[0]!.checksum = "0".repeat(64);
    expect(() => validateCaptureAdoption(drifted, "before")).toThrow(/checksum/);
    const failed = snapshot();
    failed.history[0]!.finished_at = null;
    expect(() => validateCaptureAdoption(failed, "before")).toThrow(/unfinished/i);
  });

  it("rejects unknown, duplicated or out-of-order active history", () => {
    for (const name of ["unknown", target, "20261202120000_run_capture_scope"]) {
      const state = snapshot();
      state.history.push({ ...state.history[0]!, migration_name: name });
      expect(() => validateCaptureAdoption(state, "before")).toThrow();
    }
    const duplicate = snapshot();
    duplicate.history.push({ ...duplicate.history[0]! });
    expect(() => validateCaptureAdoption(duplicate, "before")).toThrow(/duplicate/i);
  });

  it("allows a rolled-back predecessor attempt only when a successful retry matches", () => {
    const state = snapshot();
    state.history.push({ ...state.history[0]!, finished_at: null, rolled_back_at: "2026-01-01" });
    expect(validateCaptureAdoption(state, "before")).toEqual({ columns: false, index: false });
  });

  it("refuses unsupported or missing public tables", () => {
    const state = snapshot();
    state.tables[0]!.kind = "p";
    expect(() => validateCaptureAdoption(state, "before")).toThrow(/ordinary public/);
    state.tables = [];
    expect(() => validateCaptureAdoption(state, "before")).toThrow(/ordinary public/);
  });

  it("allows exact interrupted preapply state but refuses partial or drifted columns", () => {
    const state = prepared();
    state.indexes = [];
    expect(validateCaptureAdoption(state, "before")).toEqual({ columns: true, index: false });
    expect(() => validateCaptureAdoption(state, "prepared")).toThrow(/index/);
    state.columns.pop();
    expect(() => validateCaptureAdoption(state, "before")).toThrow(/columns/);
    for (const property of ["type", "not_null", "has_default", "identity", "generated"] as const) {
      const drifted = prepared();
      Object.assign(drifted.columns[0]!, {
        [property]:
          property === "type"
            ? "timestamp without time zone"
            : property === "identity" || property === "generated"
              ? "s"
              : true,
      });
      expect(() => validateCaptureAdoption(drifted, "prepared")).toThrow(/columns/);
    }
  });

  it("requires an exact, valid, ready and live legacy index before resolve", () => {
    expect(validateCaptureAdoption(prepared(), "prepared")).toEqual({ columns: true, index: true });
    for (const property of ["valid", "ready", "live"] as const) {
      const state = prepared();
      state.indexes[0]![property] = false;
      expect(() => validateCaptureAdoption(state, "prepared")).toThrow(/index/);
    }
    for (const suffix of [" WHERE true", " INCLUDE (id)", " WITH (fillfactor='70')"]) {
      const state = prepared();
      state.indexes[0]!.definition += suffix;
      expect(() => validateCaptureAdoption(state, "prepared")).toThrow(/index/);
    }
    const reversed = prepared();
    reversed.indexes[0]!.definition = reversed.indexes[0]!.definition.replace(
      '("memoryCaptureDueAt", "memoryCapturedAt")',
      '("memoryCapturedAt", "memoryCaptureDueAt")',
    );
    expect(() => validateCaptureAdoption(reversed, "prepared")).toThrow(/index/);
  });

  it("reads back the original migration checksum after official Prisma resolve", () => {
    const state = prepared();
    expect(() => validateCaptureAdoption(state, "resolved")).toThrow(/resolved/);
    state.history.push({
      migration_name: target,
      checksum: checksum(target),
      finished_at: "2026-01-01",
      rolled_back_at: null,
    });
    expect(validateCaptureAdoption(state, "resolved")).toEqual({ columns: true, index: true });
    state.history.at(-1)!.checksum = "0".repeat(64);
    expect(() => validateCaptureAdoption(state, "resolved")).toThrow(/checksum/);
  });
});
