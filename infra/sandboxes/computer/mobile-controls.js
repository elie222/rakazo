// Mobile text editing complements noVNC's normal hardware keyboard events.
export function textEdits(previous, next) {
  const before = Array.from(previous);
  const after = Array.from(next);
  let common = 0;
  while (common < before.length && common < after.length && before[common] === after[common])
    common++;
  return { backspaces: before.length - common, text: after.slice(common).join("") };
}

export function textKeysyms(text) {
  return Array.from(text, (char) => {
    const code = char.codePointAt(0);
    return code === 10 ? 0xff0d : code === 9 ? 0xff09 : code <= 255 ? code : 0x01000000 + code;
  });
}

export function attachMobileControls(rfb, Keyboard, pasteHostText) {
  const toolbar = document.getElementById("controls");
  const input = document.getElementById("keyboard-input");
  const keyboardButton = document.getElementById("keyboard-button");
  const clipboard = document.getElementById("clipboard-dialog");
  const clipboardText = document.getElementById("clipboard-text");
  if (rfb.viewOnly) return;
  toolbar.hidden = false;
  let previous = "_".repeat(32);
  input.value = previous;
  const keyboard = new Keyboard(input);
  keyboard.onkeyevent = (keysym, code, down) => rfb.sendKey(keysym, code, down);
  keyboard.grab();
  input.addEventListener("input", () => {
    const edits = textEdits(previous, input.value);
    for (let i = 0; i < edits.backspaces; i++) rfb.sendKey(0xff08, "Backspace");
    for (const keysym of textKeysyms(edits.text)) rfb.sendKey(keysym);
    previous = input.value;
    if (!previous.length || previous.length > 1024) {
      previous = "_".repeat(32);
      input.value = previous;
      input.setSelectionRange(previous.length, previous.length);
    }
  });
  keyboardButton.addEventListener("pointerdown", (event) => event.preventDefault());
  keyboardButton.addEventListener("click", () => {
    if (document.activeElement === input) input.blur();
    else {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  });
  input.addEventListener("focus", () => {
    rfb.focusOnClick = false;
    keyboardButton.setAttribute("aria-pressed", "true");
  });
  input.addEventListener("blur", () => {
    rfb.focusOnClick = true;
    keyboardButton.setAttribute("aria-pressed", "false");
  });
  // Keep the phone keyboard open while tapping the remote desktop.
  document.getElementById("screen").addEventListener(
    "mousedown",
    (event) => {
      if (document.activeElement === input) event.preventDefault();
    },
    true,
  );
  document.getElementById("clipboard-button").addEventListener("click", () => {
    input.blur();
    clipboard.showModal();
  });
  rfb.addEventListener("clipboard", (event) => {
    clipboardText.value = event.detail.text;
  });
  document.getElementById("clipboard-close").addEventListener("click", () => clipboard.close());
  document.getElementById("clipboard-paste").addEventListener("click", () => {
    if (pasteHostText(rfb, clipboardText.value)) clipboard.close();
  });
  document.getElementById("clipboard-copy").addEventListener("click", () => {
    clipboardText.focus();
    clipboardText.select();
    document.execCommand("copy");
  });
  // The outer app resizes with the visual viewport when the phone keyboard opens.
  rfb.addEventListener("disconnect", () => {
    keyboard.ungrab();
    toolbar.hidden = true;
    input.blur();
  });
}
