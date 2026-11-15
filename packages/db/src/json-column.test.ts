import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { JsonColumnMismatchError, readJsonColumn } from "./json-column.js";
import { storedMessageBlocks } from "./message-blocks.js";

const Allocations = z.array(z.object({ lotId: z.string() }));
const SECRET = "private text a column held";

let sink: ReturnType<typeof createTestSink>;
const warnings = () =>
  sink.events.map(({ level, table, column, id }) => ({ level, table, column, id }));
beforeEach(() => {
  sink = createTestSink();
  installLogger(createLogger({ service: "rakazo-api", sinks: [sink], level: "debug" }));
});

describe("readJsonColumn", () => {
  it("returns the parsed value when the stored value matches", () => {
    const row = { table: "entries", column: "allocations", id: "match" };
    expect(readJsonColumn(Allocations, [{ lotId: "lot-1" }], row, "reject")).toEqual([
      { lotId: "lot-1" },
    ]);
    expect(sink.events).toEqual([]);
  });

  it("rejects with the table, column and row id, and never the stored value", () => {
    const row = { table: "entries", column: "allocations", id: "reject" };
    let thrown: unknown;
    try {
      readJsonColumn(Allocations, [{ lotId: 7, note: SECRET }], row, "reject");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(JsonColumnMismatchError);
    expect((thrown as JsonColumnMismatchError).row).toEqual(row);
    expect(String(thrown)).toContain("entries.allocations of row reject");
    expect(JSON.stringify(thrown) + String(thrown)).not.toContain(SECRET);
  });

  it("falls back to the stated default and warns once per row without the value", () => {
    const row = { table: "entries", column: "allocations", id: "fallback" };
    for (let read = 0; read < 3; read += 1) {
      expect(readJsonColumn(Allocations, SECRET, row, { fallback: [] })).toEqual([]);
    }
    readJsonColumn(Allocations, SECRET, { ...row, id: "another" }, { fallback: [] });
    expect(warnings()).toEqual([
      { level: "warn", ...row },
      { level: "warn", ...row, id: "another" },
    ]);
    expect(JSON.stringify(sink.events)).not.toContain(SECRET);
  });
});

describe("storedMessageBlocks", () => {
  it("keeps blocks as stored, including kinds and fields from earlier releases", () => {
    const blocks = [
      { kind: "text", text: "hello" },
      { kind: "retired_kind", extra: 1 },
    ];
    expect(storedMessageBlocks({ id: "message-ok", blocks })).toEqual(blocks);
    expect(sink.events).toEqual([]);
  });

  it.each([
    ["a value that is not a list", { kind: "text", text: SECRET }],
    ["a null entry", [{ kind: "text", text: SECRET }, null]],
    ["an entry without a kind", [{ text: SECRET }]],
    ["nothing", null],
  ])("reads %s as no blocks and warns", (name, blocks) => {
    const id = `message-${name}`;
    expect(storedMessageBlocks({ id, blocks })).toEqual([]);
    expect(warnings()).toEqual([{ level: "warn", table: "messages", column: "blocks", id }]);
    expect(JSON.stringify(sink.events)).not.toContain(SECRET);
  });
});
