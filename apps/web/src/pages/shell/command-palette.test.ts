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

  it("matches Cmd/Ctrl-Shift-] in the browser", () => {
    expect(isSwitchBotHotkey(keyEvent({ key: "]", metaKey: true, shiftKey: true }))).toBe(true);
    expect(isSwitchBotHotkey(keyEvent({ key: "}", ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(
      isSwitchBotHotkey(
        keyEvent({ key: "Unidentified", code: "BracketRight", metaKey: true, shiftKey: true }),
      ),
    ).toBe(true);
    expect(isSwitchBotHotkey(keyEvent({ key: "]", metaKey: true }))).toBe(false);
    expect(isSwitchBotHotkey(keyEvent({ key: "[", metaKey: true, shiftKey: true }))).toBe(false);
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
  });

  it("matches Cmd/Ctrl-Shift-[ in the browser", () => {
    expect(isSwitchBotBackHotkey(keyEvent({ key: "[", metaKey: true, shiftKey: true }))).toBe(true);
    expect(isSwitchBotBackHotkey(keyEvent({ key: "{", ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isSwitchBotBackHotkey(keyEvent({ key: "[", metaKey: true }))).toBe(false);
    expect(isSwitchBotBackHotkey(keyEvent({ key: "]", metaKey: true, shiftKey: true }))).toBe(
      false,
    );
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
