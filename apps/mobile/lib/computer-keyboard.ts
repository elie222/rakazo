export const COMPUTER_KEYBOARD_SEED = "_".repeat(99);

export const NATIVE_COMPUTER_KEYBOARD_BOOT = "window.__rakazoNativeKeys=true;true;";

export type ComputerKeyName =
  | "Escape"
  | "Tab"
  | "Return"
  | "Backspace"
  | "ArrowLeft"
  | "ArrowUp"
  | "ArrowRight"
  | "ArrowDown";

export type ComputerKeyboardCommand =
  | { type: "text"; text: string }
  | { type: "backspace"; count: number }
  | { type: "key"; name: ComputerKeyName; control?: boolean }
  | { type: "char"; text: string; control?: boolean };

/** Same edit shape as the in-viewer keyboard: insertions and deletions. */
export function computerKeyboardChanges(
  oldValue: string,
  newValue: string,
  selectionStart = newValue.length,
): { backspaces: number; text: string } {
  const newLength = Math.max(selectionStart ?? newValue.length, newValue.length);
  const oldLength = oldValue.length;
  let inputCount = newLength - oldLength;
  let backspaces = inputCount < 0 ? -inputCount : 0;

  for (let index = 0; index < Math.min(oldLength, newLength); index += 1) {
    if (newValue.charAt(index) !== oldValue.charAt(index)) {
      inputCount = newLength - index;
      backspaces = oldLength - index;
      break;
    }
  }

  return {
    backspaces,
    text: newValue.slice(newLength - inputCount, newLength),
  };
}

export function nextComputerKeyboardDraft(next: string): string {
  if (next.length < 1 || next.length > COMPUTER_KEYBOARD_SEED.length * 2) {
    return COMPUTER_KEYBOARD_SEED;
  }
  return next;
}

/** One newline per Return so a later Backspace deletes that break before the text before it. */
function withReturnBoundaries(value: string): string {
  return value.replace(/\r\n|\r/g, "\n");
}

/** Leading seed characters that were never sent. An edit there is not the remote caret. */
export function computerKeyboardPadding(draft: string): number {
  const seed = COMPUTER_KEYBOARD_SEED;
  if (draft.startsWith(seed)) return seed.length;
  if (seed.startsWith(draft)) return draft.length;
  let index = 0;
  const limit = Math.min(draft.length, seed.length);
  while (index < limit && draft.charAt(index) === seed.charAt(index)) index += 1;
  return index;
}

/**
 * Appends and end deletions of sent text match a remote caret at the end of the draft.
 * A deletion that enters the unsent seed is rejected, as is any other change inside that padding.
 * A correction in the typed suffix is replayed from the first changed character through the end.
 */
export function isRemoteAlignedKeyboardEdit(oldValue: string, newValue: string): boolean {
  if (oldValue.startsWith(newValue)) {
    return newValue.length >= computerKeyboardPadding(oldValue);
  }
  if (newValue.startsWith(oldValue)) return true;
  let index = 0;
  const limit = Math.min(oldValue.length, newValue.length);
  while (index < limit && oldValue.charAt(index) === newValue.charAt(index)) index += 1;
  return index >= computerKeyboardPadding(oldValue);
}

export function normalizeComputerKeyboardEdit(
  oldValue: string,
  nextValue: string,
): { changes: { backspaces: number; text: string }; draft: string; aligned: boolean } {
  const next = withReturnBoundaries(nextValue);
  if (!isRemoteAlignedKeyboardEdit(oldValue, next)) {
    return { changes: { backspaces: 0, text: "" }, draft: oldValue, aligned: false };
  }
  return {
    changes: computerKeyboardChanges(oldValue, next),
    draft: nextComputerKeyboardDraft(next),
    aligned: true,
  };
}

export function commandsForKeyboardChange(
  changes: { backspaces: number; text: string },
  control: boolean,
): ComputerKeyboardCommand[] {
  const commands: ComputerKeyboardCommand[] = [];
  let controlPending = control;
  if (changes.backspaces > 0) {
    if (controlPending) {
      commands.push({ type: "key", name: "Backspace", control: true });
      controlPending = false;
      if (changes.backspaces > 1) {
        commands.push({ type: "backspace", count: changes.backspaces - 1 });
      }
    } else {
      commands.push({ type: "backspace", count: changes.backspaces });
    }
  }

  let plain = "";
  const flush = () => {
    if (!plain) return;
    commands.push({ type: "text", text: plain });
    plain = "";
  };
  const characters = Array.from(changes.text);
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index] ?? "";
    if (character === "\r" || character === "\n") {
      if (character === "\r" && characters[index + 1] === "\n") index += 1;
      flush();
      commands.push(
        controlPending
          ? { type: "key", name: "Return", control: true }
          : { type: "key", name: "Return" },
      );
      controlPending = false;
      continue;
    }
    if (controlPending) {
      flush();
      commands.push({ type: "char", text: character, control: true });
      controlPending = false;
      continue;
    }
    plain += character;
  }
  flush();
  return commands;
}

/** JSON embedded as a JS expression. Escapes break out of the injected call. */
export function computerKeyboardScript(command: ComputerKeyboardCommand): string {
  const json = JSON.stringify(command)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `window.rakazoComputerKeyboard?.run(${json});true;`;
}

export const COMPUTER_KEYBOARD_READY_MESSAGE = "rakazo-computer-keyboard-ready";

const COMPUTER_KEYBOARD_READY_POLLS = 300;

export function computerKeyboardReadyProbe(session: string): string {
  const message = JSON.stringify(`${COMPUTER_KEYBOARD_READY_MESSAGE}:${session}`)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `(function(){var left=${COMPUTER_KEYBOARD_READY_POLLS};function tick(){var bridge=window.rakazoComputerKeyboard;if(bridge&&typeof bridge.run==="function"&&window.ReactNativeWebView){window.ReactNativeWebView.postMessage(${message});return;}left-=1;if(left>0)setTimeout(tick,100);}tick();})();true;`;
}

export function isComputerKeyboardReadyMessage(data: string, session: string): boolean {
  return data === `${COMPUTER_KEYBOARD_READY_MESSAGE}:${session}`;
}

/** Hold commands until the screen page has installed the keyboard bridge, then flush in order. */
export function createComputerKeyboardBridge(): {
  push(command: ComputerKeyboardCommand): ComputerKeyboardCommand[];
  ready(): ComputerKeyboardCommand[];
  isReady(): boolean;
} {
  let accepting = false;
  const pending: ComputerKeyboardCommand[] = [];
  return {
    push(command) {
      if (!accepting) {
        pending.push(command);
        return [];
      }
      return [command];
    },
    ready() {
      if (accepting) return [];
      accepting = true;
      const flushed = pending.slice();
      pending.length = 0;
      return flushed;
    },
    isReady() {
      return accepting;
    },
  };
}
