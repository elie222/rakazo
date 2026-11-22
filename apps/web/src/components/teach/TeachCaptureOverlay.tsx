import type { TaughtSkill } from "@rakazo/contracts";
import { DEFAULT_COMPUTER_SCREEN, mapTeachPointer, teachCaptureKey } from "@rakazo/core";
import { useLayoutEffect, useMemo, useState } from "react";
import { rpc } from "../../lib/query/rpc";
import { useEventListener } from "../../lib/use-event-listener";
import {
  enqueueTeachComputerInput,
  isTeachInputStopping,
  registerTeachCaptureFinisher,
} from "./teach-computer-input-chain";

// An Escape inside one of these belongs to that popup, not to the demo.
const POPUP_SELECTOR = "[role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox']";

export function TeachCaptureOverlay({
  botId,
  skill,
  enabled,
  screenWidth,
  screenHeight,
}: {
  botId: string;
  skill: TaughtSkill | null;
  enabled: boolean;
  screenWidth?: number;
  screenHeight?: number;
}) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const width = screenWidth ?? DEFAULT_COMPUTER_SCREEN.width;
  const height = screenHeight ?? DEFAULT_COMPUTER_SCREEN.height;
  const recordingSkillId = enabled && skill?.status === "recording" ? skill.id : null;
  const capture = useMemo(
    () =>
      target && recordingSkillId
        ? createTeachCapture(target, botId, recordingSkillId, width, height)
        : null,
    [target, botId, recordingSkillId, width, height],
  );
  useLayoutEffect(() => {
    if (!capture || !recordingSkillId) return;
    const unregister = registerTeachCaptureFinisher(recordingSkillId, capture.finishPointer);
    return () => {
      unregister();
      capture.finishPointer();
    };
  }, [capture, recordingSkillId]);

  const activeTarget = capture ? target : null;
  useEventListener(activeTarget, "pointerdown", (event) => capture?.onPointerDown(event));
  useEventListener(activeTarget, "pointermove", (event) => capture?.onPointerMove(event));
  useEventListener(activeTarget, "pointerup", (event) => capture?.onPointerUp(event));
  useEventListener(activeTarget, "pointercancel", (event) => capture?.onPointerInterrupted(event));
  useEventListener(activeTarget, "lostpointercapture", (event) =>
    capture?.onPointerInterrupted(event),
  );
  useEventListener(activeTarget, "wheel", (event) => capture?.onWheel(event), { passive: false });
  useEventListener(activeTarget, "contextmenu", (event) => event.preventDefault());
  // Prevent a recorded Escape before the page can interpret it as Close computer.
  useEventListener(capture ? window : null, "keydown", (event) => capture?.onKeyDown(event), true);

  if (!recordingSkillId) return null;
  return (
    <div
      ref={setTarget}
      data-testid="teach-capture-overlay"
      role="presentation"
      className="absolute inset-0 z-10 cursor-crosshair bg-transparent"
    />
  );
}

function createTeachCapture(
  target: HTMLDivElement,
  botId: string,
  skillId: string,
  width: number,
  height: number,
) {
  function enqueueInput(task: () => Promise<void>) {
    void enqueueTeachComputerInput(botId, task);
  }

  function pointerAt(event: MouseEvent) {
    return mapTeachPointer(event.clientX, event.clientY, target.getBoundingClientRect(), {
      width,
      height,
    });
  }

  async function sendPointer(
    type: "move" | "down" | "up" | "click",
    x: number,
    y: number,
    button: "left" | "right" = "left",
  ) {
    await rpc.computer.input({
      botId,
      kind: "pointer",
      payload: { x, y, button, type, skillId },
    });
  }

  async function sendKey(key: string) {
    await rpc.computer.input({ botId, kind: "key", payload: { key } });
  }

  async function sendScroll(
    direction: "up" | "down" | "left" | "right",
    amount: number,
    x: number,
    y: number,
  ) {
    await rpc.computer.input({
      botId,
      kind: "scroll",
      payload: { direction, amount, x, y },
    });
  }

  type Point = ReturnType<typeof pointerAt>;
  type Button = "left" | "right";
  // The remote computer has one mouse. Only the pointer that pressed it can move or release it.
  let activePointer: { id: number; button: Button; point: Point } | null = null;

  function onPointerDown(event: PointerEvent) {
    event.preventDefault();
    const button = event.button === 0 ? "left" : event.button === 2 ? "right" : null;
    if (!button || activePointer || isTeachInputStopping(skillId)) return;
    target.setPointerCapture(event.pointerId);
    const point = pointerAt(event);
    activePointer = { id: event.pointerId, button, point };
    const { x, y } = point;
    enqueueInput(() => sendPointer("down", x, y, button));
  }

  // Each input is one request, one recording write and one sandbox action, so a raw pointer
  // stream would queue faster than it drains. Keep only the newest position and send it once
  // the previous one has landed.
  let pendingMove: (Point & { button: Button }) | null = null;
  let moveInFlight = false;

  function pumpMove() {
    if (moveInFlight || !pendingMove) return;
    const move = pendingMove;
    pendingMove = null;
    moveInFlight = true;
    enqueueInput(async () => {
      try {
        await sendPointer("move", move.x, move.y, move.button);
      } finally {
        moveInFlight = false;
        pumpMove();
      }
    });
  }

  function finishPointer(point?: Point) {
    if (!activePointer) return;
    const { id, button, point: previous } = activePointer;
    activePointer = null;
    const { x, y } = point ?? previous;
    const needsMove = pendingMove !== null || x !== previous.x || y !== previous.y;
    pendingMove = null;
    // The final position has to reach the sandbox before the release; dropped intermediate
    // moves are fine, a release at a stale position is not.
    if (needsMove) enqueueInput(() => sendPointer("move", x, y, button));
    enqueueInput(() => sendPointer("up", x, y, button));
    if (target.hasPointerCapture(id)) target.releasePointerCapture(id);
  }

  function onPointerMove(event: PointerEvent) {
    if (activePointer?.id !== event.pointerId) return;
    event.preventDefault();
    const { button } = activePointer;
    const point = pointerAt(event);
    // Releasing one button while another is still held fires pointermove, not pointerup.
    if (!(event.buttons & (button === "left" ? 1 : 2))) {
      finishPointer(point);
      return;
    }
    activePointer.point = point;
    pendingMove = { ...point, button };
    pumpMove();
  }

  function onPointerUp(event: PointerEvent) {
    event.preventDefault();
    if (activePointer?.id !== event.pointerId) return;
    finishPointer(pointerAt(event));
  }

  function onPointerInterrupted(event: PointerEvent) {
    // Cancellation and capture loss do not identify a released mouse button. Use the one
    // we forwarded, at its last known position, and ignore interruptions of other pointers.
    if (activePointer?.id !== event.pointerId) return;
    finishPointer();
  }

  function onWheel(event: WheelEvent) {
    event.preventDefault();
    if (isTeachInputStopping(skillId)) return;
    // A mostly sideways wheel or trackpad swipe scrolls left or right.
    const sideways = Math.abs(event.deltaX) > Math.abs(event.deltaY);
    const delta = sideways ? event.deltaX : event.deltaY;
    const direction = sideways ? (delta < 0 ? "left" : "right") : delta < 0 ? "up" : "down";
    const amount = Math.min(20, Math.max(1, Math.round(Math.abs(delta) / 80) || 1));
    // The computer scrolls what is under the same point on its screen.
    const { x, y } = pointerAt(event);
    enqueueInput(() => sendScroll(direction, amount, x, y));
  }

  function onKeyDown(event: KeyboardEvent) {
    if (isTeachInputStopping(skillId)) return;
    // Keys aimed at page controls (the Stop teaching button, dialogs) must keep working;
    // only keystrokes with no other target belong to the demo.
    if (
      event.target instanceof HTMLElement &&
      event.target.closest("button, input, textarea, select, a, [contenteditable]")
    ) {
      return;
    }
    if (
      event.key === "Escape" &&
      event.target instanceof HTMLElement &&
      event.target.closest(POPUP_SELECTOR)
    ) {
      return;
    }
    const key = teachCaptureKey(event.key, event);
    if (!key) return;
    event.preventDefault();
    enqueueInput(() => sendKey(key));
  }

  return {
    finishPointer,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerInterrupted,
    onWheel,
    onKeyDown,
  };
}
