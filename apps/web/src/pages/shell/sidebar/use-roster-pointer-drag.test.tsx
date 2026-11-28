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

function Roster({ activeSpaceId = "a" }: { activeSpaceId?: string }) {
  const startDrag = useRosterPointerDrag({ slots, activeSpaceId, ...handlers });
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

function pointer(
  target: EventTarget,
  type: string,
  x: number,
  y: number,
  { pointerType = "mouse", buttons = type === "pointerup" ? 0 : 1 } = {},
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons,
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

const key = (name: string) =>
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: name }));
  });

it("cancels the drag on Escape and still keeps its release from opening the chat", () => {
  pointer(el("a1"), "pointerdown", 10, 10);
  pointer(window, "pointermove", 50, 40);
  key("Escape");
  expect(cursor()).toBeUndefined();
  expect(handlers.setDraggedBotId).toHaveBeenLastCalledWith(null);
  expect(handlers.setRosterDropKey).toHaveBeenLastCalledWith(null);

  pointer(window, "pointermove", 60, 40);
  expect(cursor()).toBeUndefined();
  pointer(window, "pointerup", 60, 40);
  expect(handlers.applyRosterDrop).not.toHaveBeenCalled();
  act(() => el("a1").click());
  expect(open).not.toHaveBeenCalled();
});

it("never starts a drag after a release the page missed", () => {
  pointer(el("a1"), "pointerdown", 10, 10);
  // Released outside the window before the drag began: the next move has no button held.
  pointer(window, "pointermove", 50, 40, { buttons: 0 });
  pointer(window, "pointermove", 60, 40, { buttons: 0 });
  expect(handlers.setDraggedBotId).not.toHaveBeenCalled();
  expect(cursor()).toBeUndefined();
});

it("ends a started drag whose release the page missed, without dropping", () => {
  pointer(el("a1"), "pointerdown", 10, 10);
  pointer(window, "pointermove", 50, 40);
  pointer(window, "pointermove", 60, 40, { buttons: 0 });
  expect(cursor()).toBeUndefined();
  expect(handlers.setDraggedBotId).toHaveBeenLastCalledWith(null);
  expect(handlers.applyRosterDrop).not.toHaveBeenCalled();
  act(() => el("a1").click());
  expect(open).toHaveBeenCalledOnce();
});

it("lets keyboard clicks through after a drag ends without a release", () => {
  for (const end of [
    () => act(() => window.dispatchEvent(new Event("blur"))),
    () => pointer(window, "pointercancel", 50, 40),
  ]) {
    pointer(el("a1"), "pointerdown", 10, 10);
    pointer(window, "pointermove", 50, 40);
    end();
    expect(cursor()).toBeUndefined();
    // Enter on a focused row clicks it with no pointer press first.
    act(() => el("a1").click());
  }
  expect(open).toHaveBeenCalledTimes(2);
  expect(handlers.applyRosterDrop).not.toHaveBeenCalled();
});

it("clears a swallowed click that never came at the next key press", () => {
  pointer(el("a1"), "pointerdown", 10, 10);
  pointer(window, "pointermove", 150, 40);
  pointer(window, "pointerup", 150, 40);
  key("Enter");
  act(() => el("a1").click());
  expect(open).toHaveBeenCalledOnce();
});

it("clears the drag in the parent when the roster goes away mid-drag", async () => {
  pointer(el("a1"), "pointerdown", 10, 10);
  pointer(window, "pointermove", 50, 40);
  handlers.setDraggedBotId.mockClear();
  handlers.setRosterDropKey.mockClear();
  await act(async () => root.render(null));
  expect(handlers.setDraggedBotId).toHaveBeenCalledExactlyOnceWith(null);
  expect(handlers.setRosterDropKey).toHaveBeenCalledExactlyOnceWith(null);
  expect(cursor()).toBeUndefined();
});

it("judges the drop where the pointer is released, even without a move there", () => {
  pointer(el("a1"), "pointerdown", 10, 10);
  pointer(window, "pointermove", 50, 40);
  expect(handlers.setRosterDropKey).toHaveBeenLastCalledWith("row:bot:a2");
  // Released over another Space with no move reported at that spot.
  pointer(window, "pointerup", 150, 40);
  expect(handlers.applyRosterDrop).not.toHaveBeenCalled();
  expect(handlers.setDraggedBotId).toHaveBeenLastCalledWith(null);
  expect(cursor()).toBeUndefined();
});

it("shows a bot outside the active Space as not movable anywhere", async () => {
  await act(async () => root.render(<Roster activeSpaceId="b" />));
  pointer(el("a1"), "pointerdown", 10, 10);
  pointer(window, "pointermove", 50, 40);
  expect(cursor()).toBe("refused");
  expect(handlers.setRosterDropKey).not.toHaveBeenCalled();
  pointer(window, "pointermove", 300, 300);
  expect(cursor()).toBe("refused");
  pointer(window, "pointerup", 50, 40);
  expect(handlers.applyRosterDrop).not.toHaveBeenCalled();
  expect(cursor()).toBeUndefined();
});

it("leaves touch presses to scrolling", () => {
  pointer(el("a1"), "pointerdown", 10, 10, { pointerType: "touch" });
  pointer(window, "pointermove", 50, 40, { pointerType: "touch" });
  expect(handlers.setDraggedBotId).not.toHaveBeenCalled();
  expect(cursor()).toBeUndefined();
});
