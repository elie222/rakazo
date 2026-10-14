import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ComposerEnterToSendPref from "./composer-enter-to-send-pref.js";

import {
  COMPOSER_ENTER_TO_SEND_STORAGE_KEY,
  defaultComposerEnterToSend,
  normalizeComposerEnterToSend,
} from "./composer-enter-to-send-pref.js";

let mod: typeof ComposerEnterToSendPref;

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

beforeEach(async () => {
  vi.resetModules();
  mod = await import("./composer-enter-to-send-pref.js");
});

describe("defaultComposerEnterToSend", () => {
  it("sends on precise pointers, newline on coarse pointers", () => {
    expect(defaultComposerEnterToSend(false)).toBe(true);
    expect(defaultComposerEnterToSend(true)).toBe(false);
  });
});

describe("normalizeComposerEnterToSend", () => {
  it("parses stored flags", () => {
    expect(normalizeComposerEnterToSend("1")).toBe(true);
    expect(normalizeComposerEnterToSend("0")).toBe(false);
    expect(normalizeComposerEnterToSend("true")).toBe(true);
    expect(normalizeComposerEnterToSend("off")).toBe(false);
  });

  it("falls back to the pointer default for missing or unknown values", () => {
    expect(normalizeComposerEnterToSend(null, false)).toBe(true);
    expect(normalizeComposerEnterToSend(null, true)).toBe(false);
    expect(normalizeComposerEnterToSend("maybe", false)).toBe(true);
  });
});

describe("get/setComposerEnterToSend", () => {
  it("reads the default, persists the toggle, and notifies subscribers", () => {
    const storage = memoryStorage();
    expect(mod.getComposerEnterToSend(storage, false)).toBe(true);
    let notifications = 0;
    const unsubscribe = mod.subscribeComposerEnterToSend(() => {
      notifications += 1;
    });
    mod.setComposerEnterToSend(false, storage);
    expect(mod.getComposerEnterToSend(storage, false)).toBe(false);
    expect(storage.getItem(COMPOSER_ENTER_TO_SEND_STORAGE_KEY)).toBe("0");
    expect(notifications).toBe(1);
    unsubscribe();
    mod.setComposerEnterToSend(true, storage);
    expect(notifications).toBe(1);
    expect(storage.getItem(COMPOSER_ENTER_TO_SEND_STORAGE_KEY)).toBe("1");
  });
});
