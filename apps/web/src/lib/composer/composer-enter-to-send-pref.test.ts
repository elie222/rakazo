import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ComposerEnterToSendPref from "./composer-enter-to-send-pref.js";

const storageKey = "rakazo.composerEnterToSend";
let mod: typeof ComposerEnterToSendPref;

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

function keydown(key: string, shiftKey = false) {
  window.dispatchEvent(Object.assign(new Event("keydown"), { key, shiftKey }));
}

async function loadPreference(finePointer = false, anyFinePointer = finePointer) {
  vi.resetModules();
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), {
      matchMedia: (query: string) => ({
        matches:
          query === "(pointer: fine)"
            ? finePointer
            : query === "(any-pointer: fine)" && anyFinePointer,
      }),
    }),
  );
  vi.stubGlobal("localStorage", memoryStorage());
  mod = await import("./composer-enter-to-send-pref.js");
}

beforeEach(() => loadPreference());

describe("composerEnterToSendPreference", () => {
  it("detects a shifted first typing key on a touch device with a trackpad", async () => {
    await loadPreference(false, true);
    const preference = mod.composerEnterToSendPreference;
    const changes: boolean[] = [];
    const unsubscribe = preference.subscribe(() => changes.push(preference.get()));

    keydown("Enter");
    expect(preference.get()).toBe(false);
    keydown("A", true);

    expect(changes).toEqual([true]);
    expect(localStorage.getItem(storageKey)).toBeNull();
    unsubscribe();
  });

  it("keeps newline as the default when a touch-only browser emits printable keydowns", () => {
    keydown("a");
    expect(mod.composerEnterToSendPreference.get()).toBe(false);
  });

  it("keeps the desktop default for pasted or restored drafts", async () => {
    await loadPreference(true);

    expect(mod.composerEnterToSendPreference.get()).toBe(true);
  });

  it("honors stored off even after a hardware typing key", async () => {
    await loadPreference(false, true);
    localStorage.setItem(storageKey, "off");

    keydown("a");

    expect(mod.composerEnterToSendPreference.get()).toBe(false);
  });

  it("honors stored on before detecting a hardware keyboard", () => {
    localStorage.setItem(storageKey, "true");

    expect(mod.composerEnterToSendPreference.get()).toBe(true);
  });

  it("detects a keyboard even when local storage is unavailable", async () => {
    await loadPreference(false, true);
    vi.stubGlobal("localStorage", undefined);

    keydown("a");

    expect(mod.composerEnterToSendPreference.get()).toBe(true);
  });

  it("saves the toggle as 1 or 0", () => {
    mod.composerEnterToSendPreference.set(true);
    expect(localStorage.getItem(storageKey)).toBe("1");
    mod.composerEnterToSendPreference.set(false);
    expect(localStorage.getItem(storageKey)).toBe("0");
  });
});
