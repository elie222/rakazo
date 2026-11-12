const DEFAULT_INPUT_LENGTH = 100;

/** Return the remote key changes represented by a mobile input event. */
export function mobileInputChanges(oldValue, newValue, selectionStart = newValue.length) {
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

/** True for browsers that can present a touch keyboard. */
export function isTouchBrowser(navigatorLike = globalThis.navigator, windowLike = globalThis) {
  return Boolean(navigatorLike?.maxTouchPoints > 0 || "ontouchstart" in windowLike);
}

const ZOOM_STEPS = [1, 1.5, 2, 3];
// One button press scrolls three noVNC wheel steps (50px each).
const SCROLL_STEP = 150;
const VIEW_MARGIN = 32;

/**
 * Local zoom of the desktop view: a CSS transform on the surface that noVNC does not know
 * about, so callers convert pointer coordinates with toCanvas() before handing them to noVNC.
 */
function createViewZoom(surface) {
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  // The surface's untransformed box, in client coordinates.
  const box = () => {
    const rect = surface.getBoundingClientRect();
    return {
      left: rect.left - panX,
      top: rect.top - panY,
      width: surface.clientWidth,
      height: surface.clientHeight,
    };
  };
  const apply = () => {
    const { width, height } = box();
    panX = Math.min(0, Math.max(width * (1 - zoom), panX));
    panY = Math.min(0, Math.max(height * (1 - zoom), panY));
    surface.style.transformOrigin = "0 0";
    surface.style.transform = zoom === 1 ? "" : `translate(${panX}px, ${panY}px) scale(${zoom})`;
  };
  return {
    get zoomed() {
      return zoom > 1;
    },
    // Move a zoomed view by a share of its width: -1 shows what is left, 1 what is right.
    panBy(share) {
      panX -= share * surface.clientWidth;
      apply();
    },
    // Zoom around a client point so what is under it stays put.
    step(direction, x, y) {
      const index = ZOOM_STEPS.indexOf(zoom) + direction;
      const next = ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, index))];
      if (next === zoom) return;
      const { left, top } = box();
      panX = x - left - (x - left - panX) * (next / zoom);
      panY = y - top - (y - top - panY) * (next / zoom);
      zoom = next;
      apply();
    },
    // Pan so a client point stays in view; returns the point moved with the content.
    follow(x, y) {
      if (zoom === 1) return { x, y };
      const { left, top, width, height } = box();
      const before = { x: panX, y: panY };
      const overflow = (value, start, size) =>
        Math.min(0, value - start - VIEW_MARGIN) + Math.max(0, value - start - size + VIEW_MARGIN);
      panX -= overflow(x, left, width);
      panY -= overflow(y, top, height);
      apply();
      return { x: x + panX - before.x, y: y + panY - before.y };
    },
    // noVNC maps a client point with the canvas's on-screen box but its own unzoomed scale.
    toCanvas(x, y, bounds) {
      return { x: bounds.left + (x - bounds.left) / zoom, y: bounds.top + (y - bounds.top) / zoom };
    },
    reset() {
      zoom = 1;
      panX = 0;
      panY = 0;
      surface.style.transform = "";
    },
  };
}

/**
 * Add a relative touch trackpad that drives noVNC's mouse canvas. It starts on.
 *
 * While it is on, every touch belongs to the trackpad, on the desktop or around it: one finger
 * drags the pointer relative to where it is, a tap clicks where it is, two fingers scroll, and a
 * two-finger tap right-clicks. The finger never covers the target. The pointer is drawn here as
 * a large arrow moved on every touchmove, so it stays smooth whatever the network latency.
 * Touches are consumed at the touch level (not pointer capture) so iOS never turns them into
 * compatibility mouse events that noVNC would handle as direct touches. Optional view controls
 * (buttons with data-view="zoom-in|zoom-out|scroll-up|scroll-down|pan-left|pan-right") zoom
 * around the pointer, scroll at it and move a zoomed view; a zoomed view follows the pointer.
 */
export function attachMobileTrackpad(
  rfb,
  {
    button,
    surface,
    pointer,
    viewControls,
    documentTarget = globalThis.document,
    sensitivity = 1.5,
  },
) {
  if (!button || !surface || !documentTarget || rfb.viewOnly) return () => {};

  let enabled = false;
  let touchId = null;
  let lastX = 0;
  let lastY = 0;
  let cursorX = null;
  let cursorY = null;
  let moved = false;
  let twoFinger = false;
  let scrollY = 0;
  let scrolled = false;
  const view = createViewZoom(surface);

  const canvas = () => surface.querySelector("canvas");
  const clampToCanvas = (x, y) => {
    const bounds = canvas()?.getBoundingClientRect();
    if (!bounds) return null;
    return {
      x: Math.max(bounds.left, Math.min(bounds.right - 1, x)),
      y: Math.max(bounds.top, Math.min(bounds.bottom - 1, y)),
    };
  };
  // While a button is down, noVNC covers the page with a capture overlay and only releases it
  // when a mouseup reaches that overlay (the canvas handler stops propagation). A synthetic
  // mouseup must therefore go to the overlay, which forwards it to the canvas and releases.
  const captureOverlay = () => {
    const overlay = documentTarget.getElementById?.("noVNC_mouse_capture_elem");
    return overlay && overlay.style?.display !== "none" ? overlay : null;
  };
  const canvasPoint = () => {
    const bounds = canvas()?.getBoundingClientRect();
    if (!bounds || cursorX == null || cursorY == null) return null;
    return view.toCanvas(cursorX, cursorY, bounds);
  };
  const mouse = (type, buttonNumber = 0) => {
    const target = (type === "mouseup" && captureOverlay()) || canvas();
    const point = canvasPoint();
    if (!target || !point) return;
    target.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: point.x,
        clientY: point.y,
        button: buttonNumber,
        buttons: type === "mousedown" ? 1 << buttonNumber : 0,
      }),
    );
  };
  const click = (buttonNumber) => {
    mouse("mousedown", buttonNumber);
    mouse("mouseup", buttonNumber);
  };
  // noVNC turns every 50px of wheel delta into one scroll step at the pointer.
  const wheel = (deltaY) => {
    const target = canvas();
    const point = canvasPoint();
    if (!target || !point) return;
    target.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        clientX: point.x,
        clientY: point.y,
        deltaY,
        deltaMode: 0,
      }),
    );
  };
  const showPointer = () => {
    if (!pointer) return;
    pointer.hidden = !enabled || cursorX == null;
    if (!pointer.hidden) pointer.style.transform = `translate(${cursorX}px, ${cursorY}px)`;
  };
  const positionCursor = (deltaX = 0, deltaY = 0) => {
    const target = canvas();
    if (!target) return;
    const bounds = target.getBoundingClientRect();
    cursorX ??= bounds.left + bounds.width / 2;
    cursorY ??= bounds.top + bounds.height / 2;
    const shown = view.follow(cursorX + deltaX * sensitivity, cursorY + deltaY * sensitivity);
    const next = clampToCanvas(shown.x, shown.y);
    if (!next) return;
    cursorX = next.x;
    cursorY = next.y;
    showPointer();
    mouse("mousemove");
  };
  const setEnabled = (next) => {
    enabled = next;
    touchId = null;
    twoFinger = false;
    const label = enabled ? "Use direct touch" : "Use trackpad";
    button.setAttribute("aria-pressed", String(enabled));
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
    button.classList.toggle("active", enabled);
    surface.classList.toggle("trackpad-active", enabled);
    if (viewControls) viewControls.hidden = !enabled;
    // noVNC's own touch handling does not know about the zoom.
    if (!enabled) view.reset();
    showZoomed();
    if (enabled) positionCursor();
    showPointer();
  };
  const onButtonClick = () => setEnabled(!enabled);
  // Left and right only matter, and only show, while the view is zoomed.
  const showZoomed = () => viewControls?.toggleAttribute?.("data-zoomed", view.zoomed);
  const onViewClick = (event) => {
    const action = event.target?.closest?.("[data-view]")?.dataset.view;
    if (!enabled || cursorX == null || cursorY == null) return;
    if (action === "scroll-up" || action === "scroll-down") {
      wheel(action === "scroll-up" ? -SCROLL_STEP : SCROLL_STEP);
    } else if (action === "zoom-in" || action === "zoom-out") {
      view.step(action === "zoom-in" ? 1 : -1, cursorX, cursorY);
      showZoomed();
      positionCursor();
    } else if (action === "pan-left" || action === "pan-right") {
      view.panBy(action === "pan-left" ? -0.5 : 0.5);
      positionCursor();
    }
  };
  // The canvas only exists once noVNC connects; show the pointer then.
  const onConnect = () => {
    if (enabled) positionCursor();
  };
  const consume = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const changedTouch = (event, identifier) =>
    Array.from(event.changedTouches ?? []).find((touch) => touch.identifier === identifier);
  const averageY = (touches) => (touches[0].clientY + touches[1].clientY) / 2;
  const onTouchStart = (event) => {
    if (!enabled) return;
    consume(event);
    const touches = Array.from(event.touches ?? []);
    if (touches.length >= 2) {
      // A second finger turns the gesture into a scroll; it never moves or clicks.
      twoFinger = true;
      scrolled = false;
      scrollY = averageY(touches);
      return;
    }
    const touch = event.changedTouches?.[0];
    if (!touch) return;
    // A touch whose end was lost never blocks the next one.
    twoFinger = false;
    touchId = touch.identifier;
    lastX = touch.clientX;
    lastY = touch.clientY;
    moved = false;
  };
  const onTouchMove = (event) => {
    if (!enabled) return;
    consume(event);
    if (twoFinger) {
      const touches = Array.from(event.touches ?? []);
      if (touches.length < 2) return;
      const y = averageY(touches);
      if (Math.abs(scrollY - y) > 1) scrolled = true;
      wheel(scrollY - y);
      scrollY = y;
      return;
    }
    if (touchId === null) return;
    const touch = changedTouch(event, touchId);
    if (!touch) return;
    const deltaX = touch.clientX - lastX;
    const deltaY = touch.clientY - lastY;
    if (Math.abs(deltaX) + Math.abs(deltaY) > 1) moved = true;
    positionCursor(deltaX, deltaY);
    lastX = touch.clientX;
    lastY = touch.clientY;
  };
  const finishTouch = (event, clicks) => {
    if (!enabled) return;
    consume(event);
    if (twoFinger) {
      if ((event.touches?.length ?? 0) > 0) return;
      twoFinger = false;
      touchId = null;
      if (clicks && !scrolled) click(2);
      return;
    }
    if (touchId === null || !changedTouch(event, touchId)) return;
    touchId = null;
    if (clicks && !moved) click(0);
  };
  const onTouchEnd = (event) => finishTouch(event, true);
  const onTouchCancel = (event) => finishTouch(event, false);
  const listen = { capture: true, passive: false };

  button.hidden = false;
  button.addEventListener("click", onButtonClick);
  viewControls?.addEventListener("click", onViewClick);
  surface.addEventListener("touchstart", onTouchStart, listen);
  surface.addEventListener("touchmove", onTouchMove, listen);
  surface.addEventListener("touchend", onTouchEnd, listen);
  surface.addEventListener("touchcancel", onTouchCancel, listen);
  rfb.addEventListener?.("connect", onConnect);
  setEnabled(true);

  return () => {
    button.removeEventListener("click", onButtonClick);
    viewControls?.removeEventListener("click", onViewClick);
    surface.removeEventListener("touchstart", onTouchStart, listen);
    surface.removeEventListener("touchmove", onTouchMove, listen);
    surface.removeEventListener("touchend", onTouchEnd, listen);
    surface.removeEventListener("touchcancel", onTouchCancel, listen);
    rfb.removeEventListener?.("connect", onConnect);
    surface.classList.remove("trackpad-active");
    view.reset();
    if (viewControls) viewControls.hidden = true;
    if (pointer) pointer.hidden = true;
  };
}

const CONTROL_KEYSYM = 0xffe3;
const CONTROL_CODE = "ControlLeft";
const MOBILE_KEYS = {
  Escape: [0xff1b, "Escape"],
  Tab: [0xff09, "Tab"],
  Return: [0xff0d, "Enter"],
  ArrowLeft: [0xff51, "ArrowLeft"],
  ArrowUp: [0xff52, "ArrowUp"],
  ArrowRight: [0xff53, "ArrowRight"],
  ArrowDown: [0xff54, "ArrowDown"],
};

function keyNameFromEvent(event) {
  const target = event?.target?.closest?.("[data-key]") || event?.target;
  const name = target?.getAttribute?.("data-key");
  return typeof name === "string" ? name : "";
}

/**
 * Connect a text field to noVNC so touch keyboards can type into the remote
 * desktop, and expose Esc, Tab, Ctrl, and arrows.
 * The native app sets `window.__rakazoNativeKeys` and calls `rakazoComputerKeyboard.run`.
 */
export function attachMobileKeyboard(
  rfb,
  {
    button,
    input,
    keyBar,
    Keyboard,
    backspaceKeysym,
    lookupKeysym,
    pasteText,
    documentTarget = globalThis.document,
    windowTarget = documentTarget?.defaultView ?? globalThis,
  },
) {
  if (!button || !input || !Keyboard || !documentTarget || rfb.viewOnly) return () => {};

  let lastValue = "";
  let closeOnButtonClick = false;
  let controlLatched = false;
  let keyboardTouchAt = 0;
  let keyTouchAt = 0;
  const pageChrome = !windowTarget?.__rakazoNativeKeys;
  const visualViewport = windowTarget?.visualViewport;
  const viewportRoot = documentTarget.documentElement;
  const updateVisibleViewport = () => {
    if (documentTarget.activeElement !== input || !visualViewport) return;
    viewportRoot.style.setProperty("--mobile-visual-height", `${visualViewport.height}px`);
    viewportRoot.style.setProperty("--mobile-visual-top", `${visualViewport.offsetTop}px`);
  };
  const clearVisibleViewport = () => {
    viewportRoot.style.removeProperty("--mobile-visual-height");
    viewportRoot.style.removeProperty("--mobile-visual-top");
  };
  const resetInput = () => {
    input.value = "_".repeat(DEFAULT_INPUT_LENGTH - 1);
    lastValue = input.value;
  };
  const setOpen = (open) => {
    const label = open ? "Hide keyboard" : "Show keyboard";
    button.setAttribute("aria-pressed", String(open));
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
    button.classList.toggle("active", open);
    viewportRoot.classList.toggle("mobile-keyboard-open", open);
    // The capture field is invisible; screen readers only meet it while it takes typing.
    if (open) {
      input.removeAttribute("aria-hidden");
      updateVisibleViewport();
    } else {
      input.setAttribute("aria-hidden", "true");
      clearVisibleViewport();
    }
    rfb.focusOnClick = !open;
  };
  const namedKey = (name) => {
    if (name === "Backspace") return [backspaceKeysym, "Backspace"];
    return MOBILE_KEYS[name] ?? null;
  };
  const controlButton = () => keyBar?.querySelector?.('[data-key="Control"]');
  const setControlLatched = (next) => {
    controlLatched = next;
    const control = controlButton();
    control?.setAttribute?.("aria-pressed", String(next));
    control?.classList?.toggle?.("active", next);
  };
  const sendTap = (keysym, code, explicitControl) => {
    if (keysym == null) return;
    const latched = controlLatched;
    const control = Boolean(explicitControl) || latched;
    if (control) rfb.sendKey(CONTROL_KEYSYM, CONTROL_CODE, true);
    if (control) {
      rfb.sendKey(keysym, code, true);
      rfb.sendKey(keysym, code, false);
    } else {
      rfb.sendKey(keysym, code);
    }
    if (control) rfb.sendKey(CONTROL_KEYSYM, CONTROL_CODE, false);
    if (latched) setControlLatched(false);
  };
  const insertText = (text, explicitControl) => {
    if (typeof text !== "string" || !text) return;
    for (const character of text) {
      if (character === "\n" || character === "\r") {
        const key = namedKey("Return");
        sendTap(key[0], key[1], explicitControl);
        continue;
      }
      sendTap(lookupKeysym(character.codePointAt(0)), undefined, explicitControl);
    }
  };
  const repeatBackspace = (count) => {
    const times = Number(count);
    if (!Number.isInteger(times) || times < 1) return;
    const capped = Math.min(times, 500);
    for (let index = 0; index < capped; index += 1) rfb.sendKey(backspaceKeysym, "Backspace");
  };
  const run = (command) => {
    if (!command || typeof command !== "object") return;
    if (command.type === "text" || command.type === "char") {
      insertText(command.text, command.control === true);
      return;
    }
    if (command.type === "backspace") {
      repeatBackspace(command.count);
      return;
    }
    if (command.type !== "key") return;
    const key = namedKey(command.name);
    if (!key) return;
    sendTap(key[0], key[1], command.control === true);
  };
  const show = () => {
    try {
      input.focus({ preventScroll: true });
    } catch {
      input.focus();
    }
    const length = input.value.length;
    input.setSelectionRange?.(length, length);
  };
  const hide = () => input.blur();
  const onButtonPressStart = () => {
    if (documentTarget.activeElement === input) closeOnButtonClick = true;
  };
  const toggleKeyboard = () => {
    const shouldHide = closeOnButtonClick || documentTarget.activeElement === input;
    closeOnButtonClick = false;
    if (shouldHide) hide();
    else show();
  };
  // iOS only shows the keyboard when focus happens inside the touch, and click is too late.
  const onKeyboardTouchEnd = (event) => {
    keyboardTouchAt = Date.now();
    if (event.cancelable) event.preventDefault();
    toggleKeyboard();
  };
  const onKeyboardClick = () => {
    if (Date.now() - keyboardTouchAt < 700) return;
    toggleKeyboard();
  };
  const onFocus = () => setOpen(true);
  const onBlur = () => setOpen(false);
  const onInput = (event) => {
    if (!lastValue) resetInput();
    const newValue = event.target.value;
    const changes = mobileInputChanges(lastValue, newValue, event.target.selectionStart);
    if (
      typeof pasteText === "function" &&
      event.inputType === "insertFromPaste" &&
      changes.text &&
      pasteText(changes.text)
    ) {
      resetInput();
      return;
    }
    repeatBackspace(changes.backspaces);
    insertText(changes.text, false);

    if (newValue.length > 2 * DEFAULT_INPUT_LENGTH) {
      resetInput();
    } else if (newValue.length < 1) {
      resetInput();
      input.blur();
      setTimeout(() => input.focus(), 0);
    } else {
      lastValue = newValue;
    }
  };
  const activateKey = (name) => {
    if (name === "Control") {
      setControlLatched(!controlLatched);
      return;
    }
    const key = namedKey(name);
    if (!key) return;
    sendTap(key[0], key[1], false);
  };
  const onKeyPointerDown = (event) => {
    if (!keyNameFromEvent(event)) return;
    event.preventDefault();
  };
  const onKeyTouchEnd = (event) => {
    const name = keyNameFromEvent(event);
    if (!name) return;
    keyTouchAt = Date.now();
    if (event.cancelable) event.preventDefault();
    activateKey(name);
  };
  const onKeyClick = (event) => {
    const name = keyNameFromEvent(event);
    if (!name || Date.now() - keyTouchAt < 700) return;
    event.preventDefault?.();
    activateKey(name);
  };
  const isChromeTarget = (target) => {
    if (target === button || button.contains?.(target)) return true;
    if (button.parentElement?.contains?.(target)) return true;
    if (keyBar && (target === keyBar || keyBar.contains?.(target))) return true;
    return false;
  };
  const keepOpen = (event) => {
    if (documentTarget.activeElement !== input) return;
    // Let chrome controls (keyboard, paste, trackpad, keys) receive the tap.
    if (isChromeTarget(event.target)) return;
    event.preventDefault();
  };
  // Touch/pointer first: blur can run before a synthesized mousedown on mobile.
  const keepOpenEvents = ["pointerdown", "touchstart", "mousedown"];

  resetInput();
  const keyboard = new Keyboard(input);
  keyboard.onkeyevent = (keysym, code, down) => rfb.sendKey(keysym, code, down);
  keyboard.grab();
  if (pageChrome) {
    button.hidden = false;
    if (keyBar) keyBar.hidden = false;
  } else {
    input.setAttribute("aria-hidden", "true");
  }
  if (windowTarget) windowTarget.rakazoComputerKeyboard = { run };
  for (const type of keepOpenEvents) button.addEventListener(type, onButtonPressStart);
  button.addEventListener("touchend", onKeyboardTouchEnd, { passive: false });
  button.addEventListener("click", onKeyboardClick);
  input.addEventListener("input", onInput);
  input.addEventListener("focus", onFocus);
  input.addEventListener("blur", onBlur);
  if (keyBar) {
    for (const type of keepOpenEvents) {
      keyBar.addEventListener(type, onKeyPointerDown, { passive: false });
    }
    keyBar.addEventListener("touchend", onKeyTouchEnd, { passive: false });
    keyBar.addEventListener("click", onKeyClick);
  }
  visualViewport?.addEventListener("resize", updateVisibleViewport);
  visualViewport?.addEventListener("scroll", updateVisibleViewport);
  for (const type of keepOpenEvents) {
    documentTarget.documentElement.addEventListener(type, keepOpen, true);
  }

  return () => {
    keyboard.ungrab?.();
    for (const type of keepOpenEvents) button.removeEventListener(type, onButtonPressStart);
    button.removeEventListener("touchend", onKeyboardTouchEnd);
    button.removeEventListener("click", onKeyboardClick);
    input.removeEventListener("input", onInput);
    input.removeEventListener("focus", onFocus);
    input.removeEventListener("blur", onBlur);
    if (keyBar) {
      for (const type of keepOpenEvents) keyBar.removeEventListener(type, onKeyPointerDown);
      keyBar.removeEventListener("touchend", onKeyTouchEnd);
      keyBar.removeEventListener("click", onKeyClick);
    }
    visualViewport?.removeEventListener("resize", updateVisibleViewport);
    visualViewport?.removeEventListener("scroll", updateVisibleViewport);
    viewportRoot.classList.remove("mobile-keyboard-open");
    clearVisibleViewport();
    for (const type of keepOpenEvents) {
      documentTarget.documentElement.removeEventListener(type, keepOpen, true);
    }
    if (windowTarget) delete windowTarget.rakazoComputerKeyboard;
  };
}
