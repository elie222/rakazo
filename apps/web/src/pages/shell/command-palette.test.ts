import { describe, expect, it } from "vitest";
import {
  cycleBotId,
  isCommandPaletteHotkey,
  isCreateMenuHotkey,
  isSwitchBotBackHotkey,
  isSwitchBotHotkey,
} from "./command-palette-hotkey";

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

describe("isSwitchBotHotkey", () => {
  it("matches Ctrl-Tab in the desktop app", () => {
    expect(isSwitchBotHotkey(keyEvent({ key: "Tab", ctrlKey: true }))).toBe(true);
    expect(isSwitchBotHotkey(keyEvent({ key: "Tab", metaKey: true }))).toBe(false);
    expect(isSwitchBotHotkey(keyEvent({ key: "Tab", ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isSwitchBotHotkey(keyEvent({ key: "Tab", ctrlKey: true, repeat: true }))).toBe(false);
  });
});

describe.each([
  ["next", isSwitchBotHotkey, "ArrowDown"],
  ["previous", isSwitchBotBackHotkey, "ArrowUp"],
] as const)("%s bot browser shortcut", (_direction, matches, key) => {
  it.each(["metaKey", "ctrlKey"] as const)("requires %s and Shift", (modifier) => {
    const chord = { key, [modifier]: true, shiftKey: true };
    expect(matches(keyEvent(chord))).toBe(true);
    expect(matches(keyEvent({ ...chord, shiftKey: false }))).toBe(false);
    expect(matches(keyEvent({ ...chord, altKey: true }))).toBe(false);
    expect(matches(keyEvent({ ...chord, repeat: true }))).toBe(false);
    for (const other of ["ArrowLeft", "ArrowRight", "[", "]"]) {
      expect(matches(keyEvent({ ...chord, key: other }))).toBe(false);
    }
  });

  it("rejects unmodified arrows and Alt reorder chords", () => {
    expect(matches(keyEvent({ key }))).toBe(false);
    expect(matches(keyEvent({ key, shiftKey: true }))).toBe(false);
    expect(matches(keyEvent({ key, altKey: true }))).toBe(false);
    expect(
      matches(
        keyEvent({
          key: key === "ArrowDown" ? "ArrowUp" : "ArrowDown",
          metaKey: true,
          shiftKey: true,
        }),
      ),
    ).toBe(false);
  });
});

describe("isSwitchBotBackHotkey", () => {
  it("matches Ctrl-Shift-Tab in the desktop app", () => {
    expect(isSwitchBotBackHotkey(keyEvent({ key: "Tab", ctrlKey: true, shiftKey: true }))).toBe(
      true,
    );
    expect(isSwitchBotBackHotkey(keyEvent({ key: "Tab", ctrlKey: true }))).toBe(false);
    expect(isSwitchBotBackHotkey(keyEvent({ key: "Tab", metaKey: true, shiftKey: true }))).toBe(
      false,
    );
    expect(
      isSwitchBotBackHotkey(keyEvent({ key: "Tab", ctrlKey: true, shiftKey: true, repeat: true })),
    ).toBe(false);
  });
});

describe("cycleBotId", () => {
  const bots = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("wraps around at both ends", () => {
    expect(cycleBotId(bots, "a", 1)).toBe("b");
    expect(cycleBotId(bots, "c", 1)).toBe("a");
    expect(cycleBotId(bots, "a", -1)).toBe("c");
    expect(cycleBotId(bots, "b", -1)).toBe("a");
  });

  it("starts at an end when the active bot is not in the roster", () => {
    expect(cycleBotId(bots, undefined, 1)).toBe("a");
    expect(cycleBotId(bots, "missing", -1)).toBe("c");
    expect(cycleBotId([], undefined, 1)).toBeUndefined();
  });
});
