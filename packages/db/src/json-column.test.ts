import type { MessageBlock } from "@rakazo/contracts";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { JsonColumnMismatchError, readJsonColumn } from "./json-column.js";
import {
  changeMessageBlocks,
  mayBeChannelMessage,
  readMessageBlocks,
  storedMessageBlocks,
} from "./message-blocks.js";

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

describe("stored message blocks", () => {
  const dropped = () => sink.events.map(({ id, dropped }) => ({ id, dropped }));

  it("keeps blocks as stored, including kinds and fields from earlier releases", () => {
    const blocks = [
      { kind: "text", text: "hello" },
      { kind: "retired_kind", extra: 1 },
    ];
    expect(readMessageBlocks({ id: "message-ok", blocks })).toEqual({ blocks, intact: true });
    expect(sink.events).toEqual([]);
  });

  it("keeps every block beside entries that are not blocks, and says the row lost entries", () => {
    const channel = { kind: "channel_message", channelId: "channel-1" };
    const text = { kind: "text", text: "hello" };
    const message = {
      id: "message-mixed",
      blocks: [null, channel, { text: SECRET }, text, [SECRET], SECRET],
    };
    for (let read = 0; read < 2; read += 1) {
      expect(readMessageBlocks(message)).toEqual({ blocks: [channel, text], intact: false });
      expect(storedMessageBlocks(message)).toEqual([channel, text]);
    }
    expect(warnings()).toEqual([
      { level: "warn", table: "messages", column: "blocks", id: "message-mixed" },
    ]);
    expect(dropped()).toEqual([{ id: "message-mixed", dropped: 4 }]);
    expect(JSON.stringify(sink.events)).not.toContain(SECRET);
  });

  it.each([
    ["a value that is not a list", { kind: "text", text: SECRET }],
    ["nothing", null],
  ])("reads %s as no blocks from a row that lost entries, and warns", (name, blocks) => {
    const id = `message-${name}`;
    expect(readMessageBlocks({ id, blocks })).toEqual({ blocks: [], intact: false });
    expect(changeMessageBlocks({ id, blocks }, (block) => ({ ...block }))).toBeNull();
    expect(dropped()).toEqual([{ id, dropped: "all" }]);
    expect(JSON.stringify(sink.events)).not.toContain(SECRET);
  });

  it("counts a row that lost entries as one that may have come from a group", () => {
    const text = { kind: "text", text: "hello" };
    const channel = { kind: "channel_message", channelId: "channel-1" };
    const from = (id: string, blocks: unknown) => mayBeChannelMessage({ id, blocks });
    expect(from("private", [text])).toBe(false);
    expect(from("group", [text, channel])).toBe(true);
    expect(from("lost-entries", [text, null])).toBe(true);
    expect(from("no-list", "hello")).toBe(true);
  });

  describe("changed for writing back", () => {
    const card = { kind: "choice", options: [] };
    const text = { kind: "text", text: "hello" };
    const stray = { text: SECRET };
    const answered = { ...card, answerId: "a" };
    const answer = (block: MessageBlock) => (block.kind === "choice" ? (answered as never) : block);

    it("replaces only the changed block in the row's own list", () => {
      const message = { id: "message-write", blocks: [stray, text, null, card] };
      expect(changeMessageBlocks(message, answer)).toEqual({
        stored: [stray, text, null, answered],
        blocks: [text, answered],
      });
      expect(message.blocks).toEqual([stray, text, null, card]);
      expect(dropped()).toEqual([{ id: "message-write", dropped: 2 }]);
      expect(JSON.stringify(sink.events)).not.toContain(SECRET);
    });

    it("has nothing to write when no block changed", () => {
      const message = { id: "message-same", blocks: [stray, text] };
      expect(changeMessageBlocks(message, answer)).toBeNull();
      expect(changeMessageBlocks({ id: "message-clean", blocks: [text] }, answer)).toBeNull();
    });
  });
});
