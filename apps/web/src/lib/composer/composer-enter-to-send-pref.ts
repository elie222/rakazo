import {
  COMPOSER_ENTER_TO_SEND_STORAGE_KEY,
  isHardwareTypingKey,
  parseComposerEnterToSend,
  serializeComposerEnterToSend,
} from "@rakazo/core";
import { useSyncExternalStore } from "react";
import { createStoredPreference } from "../preferences/stored-preference";

export { COMPOSER_ENTER_TO_SEND_STORAGE_KEY };

const stored = createStoredPreference({
  key: COMPOSER_ENTER_TO_SEND_STORAGE_KEY,
  parse: parseComposerEnterToSend,
  serialize: (value) => (value === null ? null : serializeComposerEnterToSend(value)),
});

function hasFinePointer(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(pointer: fine)").matches === true;
}

const defaultWithFinePointer = hasFinePointer();
let hardwareKeyboardDetected = false;
const keyboardListeners = new Set<() => void>();

function detectHardwareKeyboard(event: KeyboardEvent) {
  if (
    event.keyCode === 229 ||
    !isHardwareTypingKey(event) ||
    window.matchMedia?.("(any-pointer: fine)").matches !== true
  )
    return;
  hardwareKeyboardDetected = true;
  window.removeEventListener("keydown", detectHardwareKeyboard, true);
  for (const listener of keyboardListeners) listener();
}

if (typeof window !== "undefined") {
  window.addEventListener("keydown", detectHardwareKeyboard, true);
}

function get(): boolean {
  return stored.get() ?? (defaultWithFinePointer || hardwareKeyboardDetected);
}

function subscribe(listener: () => void): () => void {
  const unsubscribe = stored.subscribe(listener);
  keyboardListeners.add(listener);
  return () => {
    unsubscribe();
    keyboardListeners.delete(listener);
  };
}

export const composerEnterToSendPreference = {
  get,
  set: (value: boolean) => stored.set(value),
  subscribe,
  use: () => useSyncExternalStore(subscribe, get, () => false),
};
