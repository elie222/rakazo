import { describe, expect, it } from "vitest";
import { studioFacts, studioNotes } from "./fixtures/studio.js";
import { noteId } from "./notes.js";

const now = new Date("2026-11-06T16:30:00Z");
const ok = (result: ReturnType<ReturnType<typeof studioNotes>["call"]>) => {
  if (!result.ok) throw new Error(result.error.message);
  return result.data as Record<string, any>;
};
const deliveries = noteId("deliveries");

describe("notes emulator", () => {
  it("searches titles and hides pages not shared with the connection", () => {
    const notes = studioNotes({ now });
    const found = ok(notes.call("search", { query: "deliveries" }));
    expect(found.results).toEqual([
      expect.objectContaining({ object: "database", id: deliveries, title: "Supplier deliveries" }),
    ]);
    expect(ok(notes.call("search", { query: "leadership" })).results).toEqual([]);
    const hidden = notes.call("read_page", { page_id: noteId("leadership") });
    expect(hidden.ok ? null : hidden.error.code).toBe("not_found");
  });

  it("filters, sorts and paginates database rows", () => {
    const notes = studioNotes({ now });
    const schema = ok(notes.call("get_database", { database_id: deliveries }));
    expect(schema.properties.Status.options).toContain("Delayed");
    const first = ok(notes.call("list_database_rows", { database_id: deliveries }));
    expect(first.results).toHaveLength(10);
    expect(first.has_more).toBe(true);
    let all = first.results.length;
    let cursor = first.next_cursor;
    while (cursor) {
      const next = ok(
        notes.call("list_database_rows", { database_id: deliveries, start_cursor: cursor }),
      );
      all += next.results.length;
      cursor = next.next_cursor;
    }
    expect(all).toBe(25);
    const open = ok(
      notes.call("list_database_rows", {
        database_id: deliveries,
        filter: {
          and: [
            { property: "Status", condition: "does_not_equal", value: "Delivered" },
            { property: "Status", condition: "does_not_equal", value: "Cancelled" },
          ],
        },
        sorts: [{ property: "PO", direction: "ascending" }],
      }),
    );
    expect(open.results.map((r: { properties: { PO: string } }) => r.properties.PO)).toEqual([
      "PO-4465",
      "PO-4471",
      "PO-4476",
      "PO-4480",
      "PO-4483",
    ]);
    const bad = notes.call("list_database_rows", {
      database_id: deliveries,
      filter: { property: "State", condition: "equals", value: "x" },
    });
    expect(bad.ok ? null : bad.error.message).toMatch(/Could not find property State/);
  });

  it("validates and records property updates", () => {
    const notes = studioNotes({ now });
    const row = noteId("delivery-PO-4471");
    const invalid = notes.call("update_page_properties", {
      page_id: row,
      properties: { Status: "Late" },
    });
    expect(invalid.ok ? null : invalid.error.message).toMatch(/"Late" is not an option for Status/);
    const badDate = notes.call("update_page_properties", {
      page_id: row,
      properties: { ETA: "next Thursday" },
    });
    expect(badDate.ok ? null : badDate.error.code).toBe("invalid_argument");
    const eta = studioFacts(now).ostravaNewEta;
    ok(
      notes.call("update_page_properties", {
        page_id: row,
        properties: { Status: "Delayed", ETA: eta },
      }),
    );
    expect(notes.writes).toHaveLength(1);
    expect(notes.writes[0]).toMatchObject({
      target: row,
      before: { Status: "In transit" },
      after: { Status: "Delayed", ETA: eta, PO: "PO-4471" },
    });
  });

  it("reads and appends page blocks, creates rows, and refuses view-only pages", () => {
    const notes = studioNotes({ now });
    const sync = ok(notes.call("read_page", { page_id: noteId("ops-sync") }));
    expect(sync.blocks.map((b: { type: string }) => b.type)).toContain("to_do");
    ok(
      notes.call("append_blocks", {
        page_id: noteId("ops-sync"),
        content: "## This week\n- [ ] Confirm Moss 07",
      }),
    );
    expect(
      notes.pages
        .get(noteId("ops-sync"))
        ?.blocks.slice(-2)
        .map((b) => b.type),
    ).toEqual(["heading_2", "to_do"]);
    const created = ok(
      notes.call("create_page", {
        database_id: deliveries,
        title: "PO-4490 · Pendant shades",
        properties: { PO: "PO-4490", Status: "Ordered", Supplier: "Brightline Lighting" },
      }),
    );
    expect(created.parent).toMatchObject({ type: "database", title: "Supplier deliveries" });
    const viewOnly = notes.call("append_blocks", {
      page_id: noteId("pricing-policy"),
      content: "Edit",
    });
    expect(viewOnly.ok ? null : viewOnly.error.code).toBe("permission_denied");
    expect(notes.writes.map((w) => w.tool)).toEqual(["append_blocks", "create_page"]);
  });

  it("applies a notes fault only after the calls it skips", () => {
    const notes = studioNotes({
      now,
      faults: { notes: [{ kind: "permission_denied", tool: "update_page_properties" }] },
    });
    expect(notes.call("search", { query: "ops" }).ok).toBe(true);
    const denied = notes.call("update_page_properties", {
      page_id: noteId("delivery-PO-4480"),
      properties: { Status: "In transit" },
    });
    expect(denied.ok ? null : denied.error.code).toBe("permission_denied");
    expect(notes.writes).toEqual([]);
  });
});
