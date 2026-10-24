import { describe, expect, it } from "vitest";
import { isCommandPaletteHotkey, isCreateMenuHotkey } from "./command-palette-hotkey";

function keyEvent(partial: Partial<KeyboardEvent> & Pick<KeyboardEvent, "key">): KeyboardEvent {
  return {
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    repeat: false,
    shiftKey: false,
    ...partial,
  } as KeyboardEvent;
}

describe("isCommandPaletteHotkey", () => {
  it("matches Cmd/Ctrl-K", () => {
    expect(isCommandPaletteHotkey(keyEvent({ key: "k", metaKey: true }))).toBe(true);
    expect(isCommandPaletteHotkey(keyEvent({ key: "K", ctrlKey: true }))).toBe(true);
  });

  it("rejects other chords", () => {
    expect(isCommandPaletteHotkey(keyEvent({ key: "k" }))).toBe(false);
    expect(isCommandPaletteHotkey(keyEvent({ key: "k", metaKey: true, shiftKey: true }))).toBe(
      false,
    );
    expect(isCommandPaletteHotkey(keyEvent({ key: "k", metaKey: true, altKey: true }))).toBe(false);
    expect(isCommandPaletteHotkey(keyEvent({ key: "k", metaKey: true, repeat: true }))).toBe(false);
    expect(isCommandPaletteHotkey(keyEvent({ key: "j", metaKey: true }))).toBe(false);
  });
});

describe("isCreateMenuHotkey", () => {
  it("matches Cmd/Ctrl-N only", () => {
    expect(isCreateMenuHotkey(keyEvent({ key: "n", metaKey: true }))).toBe(true);
    expect(isCreateMenuHotkey(keyEvent({ key: "N", ctrlKey: true }))).toBe(true);
    expect(isCreateMenuHotkey(keyEvent({ key: "n", metaKey: true, shiftKey: true }))).toBe(false);
    expect(isCreateMenuHotkey(keyEvent({ key: "k", metaKey: true }))).toBe(false);
  });
});
