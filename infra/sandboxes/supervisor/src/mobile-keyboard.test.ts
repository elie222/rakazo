import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  attachMobileKeyboard,
  attachMobileTrackpad,
  isTouchBrowser,
  mobileInputChanges,
} from "../../computer/mobile-keyboard.js";

type TouchLike = { identifier: number; clientX: number; clientY: number };
type TouchEventLike = {
  changedTouches: TouchLike[];
  touches: TouchLike[];
  preventDefault: () => void;
  stopPropagation: () => void;
  defaultPrevented: boolean;
};

/** A fake noVNC surface: a 200x100 canvas at (0,100) inside a 200x300 free area. */
function trackpadFixture() {
  const listeners = new Map<string, (event: TouchEventLike) => void>();
  const buttonListeners = new Map<string, () => void>();
  const mouseEvents: { type: string; clientX: number; clientY: number }[] = [];
  const overlay = {
    style: { display: "none" },
    events: [] as string[],
    dispatchEvent(event: { type: string }) {
      this.events.push(event.type);
      this.style.display = "none";
      return true;
    },
  };
  const canvas = {
    getBoundingClientRect: () => ({
      left: 0,
      top: 100,
      right: 200,
      bottom: 200,
      width: 200,
      height: 100,
    }),
    dispatchEvent: (event: { type: string; clientX: number; clientY: number }) => {
      mouseEvents.push({ type: event.type, clientX: event.clientX, clientY: event.clientY });
      if (event.type === "mousedown") overlay.style.display = "";
      return true;
    },
  };
  const surface = {
    addEventListener: (type: string, listener: (event: TouchEventLike) => void) =>
      listeners.set(type, listener),
    removeEventListener: () => {},
    querySelector: () => canvas,
    classList: { toggle: () => {}, remove: () => {} },
  };
  const button = {
    hidden: true,
    addEventListener: (type: string, listener: () => void) => buttonListeners.set(type, listener),
    removeEventListener: () => {},
    setAttribute: () => {},
    classList: { toggle: () => {} },
  };
  const rfb = { viewOnly: false, showDotCursor: false };
  // noVNC's mouse capture overlay is shown after a mousedown and must receive the mouseup.
  const documentTarget = {
    getElementById: (id: string) => (id === "noVNC_mouse_capture_elem" ? overlay : null),
  };
  const detach = attachMobileTrackpad(rfb, { button, surface, documentTarget, sensitivity: 1 });
  buttonListeners.get("click")?.();
  const touch = (
    type: string,
    identifier: number,
    clientX: number,
    clientY: number,
    others: TouchLike[] = [],
    batched: TouchLike[] = [],
  ) => {
    const changed = [{ identifier, clientX, clientY }, ...batched];
    const event: TouchEventLike = {
      changedTouches: changed,
      touches: type === "touchend" || type === "touchcancel" ? others : [...changed, ...others],
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation: () => {},
    };
    listeners.get(type)?.(event);
    return event;
  };
  return { touch, mouseEvents, overlay, detach };
}

function preventableEvent(target: unknown) {
  return {
    target,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
}

function keyboardFixture(overrides: { pasteText?: (text: string) => boolean } = {}) {
  const inputListeners = new Map<string, (event: object) => void>();
  const rootListeners = new Map<string, (event: ReturnType<typeof preventableEvent>) => void>();
  const keys: Array<[number, string?]> = [];
  const pasteButton = {};
  const button = {
    hidden: true,
    parentElement: { contains: (target: unknown) => target === pasteButton },
    addEventListener: () => {},
    removeEventListener: () => {},
    setAttribute: () => {},
    classList: { toggle: () => {} },
    contains: () => false,
  };
  const input = {
    value: "",
    addEventListener: (type: string, listener: (event: object) => void) =>
      inputListeners.set(type, listener),
    removeEventListener: () => {},
    focus: () => {},
    blur: () => {},
    setSelectionRange: () => {},
  };
  const documentTarget = {
    activeElement: input as unknown,
    documentElement: {
      style: { setProperty: () => {}, removeProperty: () => {} },
      classList: { toggle: () => {}, remove: () => {} },
      addEventListener: (
        type: string,
        listener: (event: ReturnType<typeof preventableEvent>) => void,
      ) => rootListeners.set(type, listener),
      removeEventListener: () => {},
    },
  };
  const rfb = {
    viewOnly: false,
    focusOnClick: true,
    sendKey: (keysym: number, code?: string) => keys.push([keysym, code]),
  };
  class Keyboard {
    onkeyevent = null;
    grab() {}
    ungrab() {}
  }
  const pasteText = overrides.pasteText;
  attachMobileKeyboard(rfb, {
    button,
    input,
    Keyboard,
    backspaceKeysym: 0xff08,
    lookupKeysym: (codePoint: number) => codePoint,
    documentTarget,
    pasteText,
  });
  return { input, inputListeners, keys, pasteText, rootListeners, pasteButton, documentTarget };
}

describe("mobile computer keyboard", () => {
  it("translates inserted and deleted text", () => {
    expect(mobileInputChanges("___", "___a", 4)).toEqual({
      backspaces: 0,
      text: "a",
    });
    expect(mobileInputChanges("___", "hi___", 2)).toEqual({
      backspaces: 3,
      text: "hi___",
    });
    expect(mobileInputChanges("___a", "___", 3)).toEqual({
      backspaces: 1,
      text: "",
    });
  });

  it("replaces corrected text instead of duplicating it", () => {
    expect(mobileInputChanges("___teh", "___the", 6)).toEqual({
      backspaces: 2,
      text: "he",
    });
  });

  it("only enables the control in touch browsers", () => {
    expect(isTouchBrowser({ maxTouchPoints: 1 }, {})).toBe(true);
    expect(isTouchBrowser({ maxTouchPoints: 0 }, { ontouchstart: null })).toBe(true);
    expect(isTouchBrowser({ maxTouchPoints: 0 }, {})).toBe(false);
  });

  it("enables a visible relative-pointer mode", () => {
    const listeners = new Map<string, () => void>();
    const classes = new Set<string>();
    const button = {
      hidden: true,
      addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
      removeEventListener: () => {},
      setAttribute: () => {},
      classList: {
        toggle: (name: string, on: boolean) => (on ? classes.add(name) : classes.delete(name)),
      },
    };
    const surface = {
      addEventListener: () => {},
      removeEventListener: () => {},
      querySelector: () => null,
      classList: { toggle: () => {}, remove: () => {} },
    };
    const rfb = { viewOnly: false, showDotCursor: false };
    const detach = attachMobileTrackpad(rfb, { button, surface, documentTarget: {} });
    listeners.get("click")?.();
    expect(button.hidden).toBe(false);
    expect(rfb.showDotCursor).toBe(true);
    expect(classes.has("active")).toBe(true);
    detach();
    expect(rfb.showDotCursor).toBe(false);
  });

  it("ships and initializes the keyboard bridge in the computer image", () => {
    const root = path.resolve(import.meta.dirname, "../../computer");
    const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
    const embed = readFileSync(path.join(root, "embed.html"), "utf8");
    const start = readFileSync(path.join(root, "start.sh"), "utf8");
    const supervisor = readFileSync(path.join(import.meta.dirname, "index.ts"), "utf8");
    expect(dockerfile).toMatch(/mobile-keyboard\.js/);
    expect(embed).toMatch(/attachMobileKeyboard/);
    expect(embed).toMatch(/mobile-keyboard-input/);
    expect(embed).toMatch(/attachMobilePaste/);
    expect(embed).toMatch(/mobile-paste/);
    expect(embed).toMatch(/attachMobileTrackpad/);
    expect(embed).toMatch(/mobile-trackpad/);
    expect(embed).toMatch(/mobile-keyboard-open #screen/);
    expect(embed).toMatch(/--mobile-visual-height/);
    expect(start).toMatch(/mobile-keyboard\.js/);
    expect(supervisor).toMatch(/"mobile-keyboard\.js"/);
  });

  it("pastes host clipboard text instead of typing an insertFromPaste", () => {
    const { input, inputListeners, keys, pasteText } = keyboardFixture({
      pasteText: vi.fn(() => true),
    });
    const seed = input.value;
    input.value = `${seed}from-phone`;
    inputListeners.get("input")?.({
      target: input,
      inputType: "insertFromPaste",
    });
    expect(pasteText).toHaveBeenCalledWith("from-phone");
    expect(keys).toEqual([]);
    expect(input.value).toBe(seed);
  });

  it("lets sibling chrome controls receive taps while the keyboard is open", () => {
    const { rootListeners, pasteButton, documentTarget, input } = keyboardFixture();
    documentTarget.activeElement = input;
    const pasteTap = preventableEvent(pasteButton);
    rootListeners.get("pointerdown")?.(pasteTap);
    expect(pasteTap.defaultPrevented).toBe(false);
    const screenTap = preventableEvent({});
    rootListeners.get("pointerdown")?.(screenTap);
    expect(screenTap.defaultPrevented).toBe(true);
  });
});

describe("mobile trackpad touches", () => {
  const stubMouseEvent = () => {
    const previous = (globalThis as { MouseEvent?: unknown }).MouseEvent;
    (globalThis as { MouseEvent?: unknown }).MouseEvent = class {
      type: string;
      clientX: number;
      clientY: number;
      constructor(type: string, init: { clientX: number; clientY: number }) {
        this.type = type;
        this.clientX = init.clientX;
        this.clientY = init.clientY;
      }
    };
    return () => {
      (globalThis as { MouseEvent?: unknown }).MouseEvent = previous;
    };
  };

  it("moves the pointer relative to a drag in the free area and clicks where it is on a tap", () => {
    const restore = stubMouseEvent();
    try {
      const fixture = trackpadFixture();
      expect(fixture.mouseEvents.at(-1)).toEqual({ type: "mousemove", clientX: 100, clientY: 150 });
      const start = fixture.touch("touchstart", 1, 50, 250);
      expect(start.defaultPrevented).toBe(true);
      fixture.touch("touchmove", 1, 70, 260);
      fixture.touch("touchend", 1, 70, 260);
      expect(fixture.mouseEvents.at(-1)).toEqual({ type: "mousemove", clientX: 120, clientY: 160 });
      fixture.touch("touchstart", 2, 30, 280);
      const end = fixture.touch("touchend", 2, 30, 280);
      expect(end.defaultPrevented).toBe(true);
      expect(fixture.mouseEvents.at(-1)).toEqual({ type: "mousedown", clientX: 120, clientY: 160 });
      expect(fixture.overlay.events).toEqual(["mouseup"]);
      expect(fixture.overlay.style.display).toBe("none");
      fixture.detach();
    } finally {
      restore();
    }
  });

  it("leaves touches on the desktop to noVNC and follows the pointer there", () => {
    const restore = stubMouseEvent();
    try {
      const fixture = trackpadFixture();
      const start = fixture.touch("touchstart", 1, 40, 120);
      expect(start.defaultPrevented).toBe(false);
      const end = fixture.touch("touchend", 1, 40, 120);
      expect(end.defaultPrevented).toBe(false);
      expect(fixture.mouseEvents.filter((event) => event.type === "mousedown")).toHaveLength(0);
      fixture.touch("touchstart", 2, 100, 250);
      fixture.touch("touchmove", 2, 110, 250);
      expect(fixture.mouseEvents.at(-1)).toEqual({ type: "mousemove", clientX: 50, clientY: 120 });
      fixture.detach();
    } finally {
      restore();
    }
  });

  it("follows a drag on the desktop so the next free-area move continues from there", () => {
    const restore = stubMouseEvent();
    try {
      const fixture = trackpadFixture();
      fixture.touch("touchstart", 1, 40, 120);
      fixture.touch("touchmove", 1, 90, 170);
      fixture.touch("touchend", 1, 90, 170);
      fixture.touch("touchstart", 2, 100, 250);
      fixture.touch("touchmove", 2, 110, 250);
      expect(fixture.mouseEvents.at(-1)).toEqual({ type: "mousemove", clientX: 100, clientY: 170 });
      fixture.detach();
    } finally {
      restore();
    }
  });

  it("ignores extra fingers during a free-area gesture and never clicks for them", () => {
    const restore = stubMouseEvent();
    try {
      const fixture = trackpadFixture();
      fixture.touch("touchstart", 1, 50, 250);
      fixture.touch("touchmove", 1, 60, 250);
      const second = fixture.touch("touchstart", 2, 150, 280, [
        { identifier: 1, clientX: 60, clientY: 250 },
      ]);
      expect(second.defaultPrevented).toBe(true);
      fixture.touch("touchmove", 2, 120, 280, [{ identifier: 1, clientX: 60, clientY: 250 }]);
      expect(fixture.mouseEvents.at(-1)).toEqual({ type: "mousemove", clientX: 110, clientY: 150 });
      fixture.touch("touchend", 2, 120, 280, [{ identifier: 1, clientX: 60, clientY: 250 }]);
      expect(fixture.mouseEvents.filter((event) => event.type === "mousedown")).toHaveLength(0);
      fixture.touch("touchmove", 1, 70, 250);
      expect(fixture.mouseEvents.at(-1)).toEqual({ type: "mousemove", clientX: 120, clientY: 150 });
      fixture.detach();
    } finally {
      restore();
    }
  });

  it("classifies every touch of a batched touchstart", () => {
    const restore = stubMouseEvent();
    try {
      const fixture = trackpadFixture();
      // One finger lands on the desktop and another in the free area in the same event.
      const start = fixture.touch(
        "touchstart",
        1,
        40,
        120,
        [],
        [{ identifier: 2, clientX: 100, clientY: 250 }],
      );
      expect(start.defaultPrevented).toBe(true);
      fixture.touch("touchmove", 2, 110, 250, [{ identifier: 1, clientX: 40, clientY: 120 }]);
      expect(fixture.mouseEvents.at(-1)).toEqual({ type: "mousemove", clientX: 50, clientY: 120 });
      fixture.detach();
    } finally {
      restore();
    }
  });

  it("starts a fresh gesture when a previous touch never reported its end", () => {
    const restore = stubMouseEvent();
    try {
      const fixture = trackpadFixture();
      fixture.touch("touchstart", 1, 50, 250);
      fixture.touch("touchmove", 1, 60, 250);
      // No touchend for touch 1. The next touch must still drive the trackpad.
      fixture.touch("touchstart", 2, 150, 280);
      fixture.touch("touchmove", 2, 140, 280);
      expect(fixture.mouseEvents.at(-1)).toEqual({ type: "mousemove", clientX: 100, clientY: 150 });
      fixture.detach();
    } finally {
      restore();
    }
  });
});
