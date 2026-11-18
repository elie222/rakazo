import { describe, expect, it } from "vitest";
import {
  addDraftNote,
  draftNoteAt,
  draftNotesWithPending,
  draftRevisionText,
  draftSegments,
} from "./draft-notes.js";

const body = "Hi Marie,\n\nI hope this message finds you well. Would you be open to a call?";

describe("draft notes", () => {
  it("trims a marked passage and keeps notes in text order", () => {
    const hope = body.indexOf("I hope");
    const ask = body.indexOf("Would");
    const later = addDraftNote(body, [], { start: ask - 1, end: body.length, note: "shorter" });
    expect(later).toEqual([{ start: ask, end: body.length, note: "shorter" }]);
    const both = addDraftNote(body, later!, { start: hope - 2, end: ask, note: " warmer " });
    expect(both?.map((note) => body.slice(note.start, note.end))).toEqual([
      "I hope this message finds you well.",
      "Would you be open to a call?",
    ]);
    expect(both?.[0]?.note).toBe("warmer");
  });

  it("refuses a blank passage, an empty note, or one over an existing note", () => {
    const notes = addDraftNote(body, [], { start: 11, end: 17, note: "x" })!;
    expect(addDraftNote(body, notes, { start: 9, end: 11, note: "x" })).toBeNull();
    expect(addDraftNote(body, notes, { start: 20, end: 30, note: "  " })).toBeNull();
    expect(addDraftNote(body, notes, { start: 15, end: 30, note: "x" })).toBeNull();
    expect(addDraftNote(body, notes, { start: 17, end: 30, note: "x" })).toHaveLength(2);
  });

  it("shows a selection as pending only when it could become a note", () => {
    const ask = body.indexOf("Would");
    const notes = addDraftNote(body, [], { start: ask, end: body.length, note: "shorter" })!;
    const hope = body.indexOf("I hope");
    const selected = draftNotesWithPending(body, notes, { start: hope, end: hope + 6 });
    expect(selected.pending).toBe(0);
    expect(selected.shown[1]).toBe(notes[0]);
    // A caret, as when a marked passage is tapped, or a range over a note, leaves the notes as is.
    for (const selection of [null, { start: ask + 2, end: ask + 2 }, { start: ask, end: ask + 5 }])
      expect(draftNotesWithPending(body, notes, selection)).toEqual({ shown: notes, pending: -1 });
  });

  it("splits the body at the notes and finds the note under an offset", () => {
    const notes = addDraftNote(body, [], { start: 0, end: 2, note: "Hello" })!;
    expect(draftSegments(body, notes)).toEqual([{ text: "Hi", note: 0 }, { text: body.slice(2) }]);
    expect(
      draftSegments(body, [])
        .map((segment) => segment.text)
        .join(""),
    ).toBe(body);
    expect(draftNoteAt(notes, 1)).toBe(0);
    expect(draftNoteAt(notes, 2)).toBe(-1);
  });

  it("writes one line per note with its passage on one line", () => {
    const notes = [
      { start: 0, end: 9, note: "Use her full name" },
      { start: 11, end: 46, note: "warmer" },
    ];
    expect(draftRevisionText(body, notes)).toBe(
      "“Hi Marie,” → Use her full name\n“I hope this message finds you well.” → warmer",
    );
    const lines = "First line\nsecond line";
    expect(draftRevisionText(lines, [{ start: 0, end: lines.length, note: "merge" }])).toBe(
      "“First line second line” → merge",
    );
  });
});
