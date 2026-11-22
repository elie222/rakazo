import { describe, expect, it } from "vitest";
import { boundLogEvent, MAX_LOG_EVENT_CHARS, MAX_LOG_STRING_CHARS } from "./bounded-event.js";
import type { LogEvent } from "./types.js";

function event(fields: Record<string, unknown> = {}): LogEvent {
  return {
    timestamp: "2026-01-02T03:04:05.000Z",
    level: "warn",
    message: "run.setup_failed",
    "service.name": "rakazo-worker",
    "run.id": "run-a",
    ...fields,
  };
}

function manyFields(count: number, key: (index: number) => string, value: unknown) {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [key(index), value]));
}

const oversized = { attempts: Array.from({ length: 200 }, () => "y".repeat(10_000)) };
const unserializable = {
  detail: {
    toJSON() {
      throw new Error("cannot serialize");
    },
  },
};

describe("boundLogEvent", () => {
  it("sends what it measured, so a field that answers differently later cannot change it", () => {
    let reads = 0;
    const changing = { toJSON: () => (++reads === 1 ? "safe" : "secret-value") };
    const bounded = boundLogEvent(event({ changing }));
    expect(JSON.stringify(bounded)).toContain("safe");
    expect(JSON.stringify(bounded)).not.toContain("secret-value");
  });

  it("keeps a shortened string within its limit, note included", () => {
    const bounded = boundLogEvent(event({ note: "x".repeat(MAX_LOG_STRING_CHARS * 2) }));
    expect((bounded.note as string).length).toBeLessThanOrEqual(MAX_LOG_STRING_CHARS);
    expect(bounded["log.truncated"]).toBe(true);
  });

  it("stays within the line limit once the shortened marker is added", () => {
    const fields: Record<string, unknown> = { long: "y".repeat(MAX_LOG_STRING_CHARS * 2) };
    // Fill to just under the limit, so only the marker would push the line over it.
    const base = JSON.stringify(boundLogEvent(event(fields))).length;
    fields.fill = "z".repeat(Math.max(0, MAX_LOG_EVENT_CHARS - base - 40));
    const bounded = boundLogEvent(event(fields));
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(MAX_LOG_EVENT_CHARS);
  });

  it("stands in for a line with a very large number of fields instead of dropping it", () => {
    const fields: Record<string, unknown> = {};
    for (let i = 0; i < 200_000; i++) fields[`f${i}`] = i;
    const bounded = boundLogEvent(event(fields));
    expect(bounded["log.oversized"]).toBe(true);
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(MAX_LOG_EVENT_CHARS);
  });

  it("keeps a line's identifiers when many fields come before them", () => {
    const fields: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) fields[`f${i}`] = "x".repeat(MAX_LOG_STRING_CHARS);
    const bounded = boundLogEvent({ ...fields, ...event({ "space.id": "space-a" }) });
    expect(bounded).toMatchObject({
      "log.oversized": true,
      message: "run.setup_failed",
      "run.id": "run-a",
      "space.id": "space-a",
    });
  });

  it("keeps the line when a field named toJSON answers something else", () => {
    const bounded = boundLogEvent(event({ toJSON: () => null }));
    expect(bounded).toMatchObject({
      "log.unserializable": true,
      message: "run.setup_failed",
      "run.id": "run-a",
    });
  });

  it("shortens a very long integer like any other text", () => {
    const bounded = boundLogEvent(event({ "run.big": 10n ** 20_000n }));
    expect((bounded["run.big"] as string).length).toBeLessThanOrEqual(MAX_LOG_STRING_CHARS);
    expect(bounded["log.truncated"]).toBe(true);
  });

  it("returns a line that serializes when a field is a BigInt", () => {
    const bounded = boundLogEvent(event({ "run.steps": 12345678901234567890n }));

    expect(JSON.parse(JSON.stringify(bounded))).toMatchObject({
      "run.id": "run-a",
      "run.steps": "12345678901234567890",
    });
  });

  it("stands in for a line whose own toJSON returns nothing", () => {
    const bounded = boundLogEvent(event({ toJSON: () => undefined }));

    expect(JSON.parse(JSON.stringify(bounded))).toMatchObject({
      message: "run.setup_failed",
      "run.id": "run-a",
      "log.unserializable": true,
    });
  });

  it.each([
    { name: "numbers", fields: manyFields(40_000, (i) => `count.${i}`, 123_456_789) },
    { name: "long field names", fields: manyFields(40, (i) => `${i}${"k".repeat(20_000)}`, 1) },
    { name: "escaped strings", fields: manyFields(400, (i) => `note.${i}`, "\u0001".repeat(900)) },
  ])("keeps the stand-in within the line limit when the line has many $name", ({ fields }) => {
    const bounded = boundLogEvent(event(fields));

    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(MAX_LOG_EVENT_CHARS);
    expect(bounded).toMatchObject({
      message: "run.setup_failed",
      "run.id": "run-a",
      "log.oversized": true,
    });
  });

  it.each([
    { flag: "log.oversized", reason: oversized },
    { flag: "log.unserializable", reason: unserializable },
  ])("keeps the $flag flag when a binding has the same name", ({ flag, reason }) => {
    expect(boundLogEvent(event({ [flag]: false, ...reason }))[flag]).toBe(true);
  });
});
