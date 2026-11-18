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

/**
 * What one change of the hidden field means on the remote, whose caret is at the field's end:
 * text added at the end is typed, text removed from the end is that many Backspaces.
 * Counted in code points, as the remote receives them. Any other change means nothing.
 */
export function computerKeyboardChanges(
  oldValue: string,
  newValue: string,
): { backspaces: number; text: string } {
  if (newValue.startsWith(oldValue)) {
    return { backspaces: 0, text: newValue.slice(oldValue.length) };
  }
  if (oldValue.startsWith(newValue)) {
    return { backspaces: Array.from(oldValue.slice(newValue.length)).length, text: "" };
  }
  return { backspaces: 0, text: "" };
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
