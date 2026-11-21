// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RosterDropAction, RosterDropSlot, RosterDropTarget } from "./roster-drop";
import { rosterSpaceAt, useRosterPointerDrag } from "./use-roster-pointer-drag";

const ownTarget: RosterDropTarget = {
  kind: "bot",
  chat: { id: "a2", sectionId: null, pinned: false },
};
const slots = new Map<string, RosterDropSlot>([
  ["row:bot:a1", { spaceId: "a", target: null, groupBotIds: ["a1", "a2"], header: false }],
  ["row:bot:a2", { spaceId: "a", target: ownTarget, groupBotIds: ["a1", "a2"], header: false }],
  ["row:bot:b1", { spaceId: "b", target: null, groupBotIds: ["b1"], header: false }],
]);

const handlers = {
  setDraggedBotId: vi.fn<(id: string | null) => void>(),
  setRosterDropKey: vi.fn<(key: string | null) => void>(),
  rosterDropAction:
    vi.fn<(target: RosterDropTarget, sameList: boolean) => RosterDropAction | null>(),
  applyRosterDrop: vi.fn<(target: RosterDropTarget, sameList: boolean, botIds: string[]) => void>(),
};
const open = vi.fn();

function Roster() {
  const startDrag = useRosterPointerDrag({ slots, ...handlers });
  return (
    <>
      <div data-roster-space="a">
        <button
          type="button"
          id="a1"
          data-roster-drop-key="row:bot:a1"
          onPointerDown={(event) => startDrag(event, { id: "a1", spaceId: "a" })}
          onClick={open}
        >
          Alpha
        </button>
        <button type="button" id="a2" data-roster-drop-key="row:bot:a2">
          Beta
        </button>
      </div>
      <div data-roster-space="b">
        <button type="button" id="b1" data-roster-drop-key="row:bot:b1">
          Other
        </button>
      </div>
    </>
  );
}

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const el = (id: string) => host.querySelector<HTMLElement>(`#${id}`)!;

beforeEach(async () => {
  handlers.rosterDropAction.mockImplementation((target) =>
    target.kind === "bot" && target.chat.id === "a2"
      ? { action: "reorder", targetBotId: "a2" }
      : null,
  );
  host = document.createElement("div");
  document.body.append(host);
  // x < 100 is Beta in the dragged bot's Space, x < 200 is a row of another Space.
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: (x: number) => (x < 100 ? el("a2") : x < 200 ? el("b1") : document.body),
  });
  const captured = new Set<number>();
  Object.assign(HTMLElement.prototype, {
    setPointerCapture: (id: number) => captured.add(id),
    releasePointerCapture: (id: number) => captured.delete(id),
    hasPointerCapture: (id: number) => captured.has(id),
  });
  root = createRoot(host);
  await act(async () => root.render(<Roster />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
  delete document.documentElement.dataset.rosterDrag;
});

function pointer(target: EventTarget, type: string, x: number, y: number, pointerType = "mouse") {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: x,
    clientY: y,
  });
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    pointerType: { value: pointerType },
  });
  act(() => {
    target.dispatchEvent(event);
  });
}

const cursor = () => document.documentElement.dataset.rosterDrag;

it("finds the Space that holds a sidebar element", () => {
  expect(rosterSpaceAt(el("b1"))).toBe("b");
  expect(rosterSpaceAt(document.body)).toBeUndefined();
  expect(rosterSpaceAt(null)).toBeUndefined();
});

it("drops a bot on a row of its own Space and keeps the press from opening the chat", () => {
  pointer(el("a1"), "pointerdown", 10, 10);
  pointer(window, "pointermove", 50, 40);
  expect(handlers.setDraggedBotId).toHaveBeenCalledWith("a1");
  expect(handlers.setRosterDropKey).toHaveBeenLastCalledWith("row:bot:a2");
  expect(cursor()).toBe("moving");

  pointer(window, "pointerup", 50, 40);
  expect(handlers.applyRosterDrop).toHaveBeenCalledExactlyOnceWith(ownTarget, true, ["a1", "a2"]);
  expect(cursor()).toBeUndefined();
  act(() => el("a1").click());
  expect(open).not.toHaveBeenCalled();
  act(() => el("a1").click());
  expect(open).toHaveBeenCalledOnce();
});

it("shows not-allowed over another Space and drops nothing there", () => {
  pointer(el("a1"), "pointerdown", 10, 10);
  pointer(window, "pointermove", 150, 40);
  expect(cursor()).toBe("refused");
  expect(handlers.setRosterDropKey).not.toHaveBeenCalled();

  pointer(window, "pointermove", 50, 40);
  expect(cursor()).toBe("moving");
  pointer(window, "pointermove", 150, 40);
  expect(cursor()).toBe("refused");
  expect(handlers.setRosterDropKey).toHaveBeenLastCalledWith(null);

  pointer(window, "pointerup", 150, 40);
  expect(handlers.applyRosterDrop).not.toHaveBeenCalled();
  expect(handlers.setDraggedBotId).toHaveBeenLastCalledWith(null);
  expect(cursor()).toBeUndefined();
});

it("keeps a short press a click", () => {
  pointer(el("a1"), "pointerdown", 10, 10);
  pointer(window, "pointermove", 12, 11);
  pointer(window, "pointerup", 12, 11);
  act(() => el("a1").click());
  expect(handlers.setDraggedBotId).not.toHaveBeenCalled();
  expect(cursor()).toBeUndefined();
  expect(open).toHaveBeenCalledOnce();
});

it("cancels the drag on Escape", () => {
  pointer(el("a1"), "pointerdown", 10, 10);
  pointer(window, "pointermove", 50, 40);
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
  expect(cursor()).toBeUndefined();
  expect(handlers.setDraggedBotId).toHaveBeenLastCalledWith(null);
  pointer(window, "pointerup", 50, 40);
  expect(handlers.applyRosterDrop).not.toHaveBeenCalled();
});

it("leaves touch presses to scrolling", () => {
  pointer(el("a1"), "pointerdown", 10, 10, "touch");
  pointer(window, "pointermove", 50, 40, "touch");
  expect(handlers.setDraggedBotId).not.toHaveBeenCalled();
  expect(cursor()).toBeUndefined();
});
