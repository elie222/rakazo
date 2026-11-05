import type { RefObject } from "react";
import { useEffect } from "react";

/** How far the thread narrows before it resists, and how much more it gives past that. */
const REACH = 64;
const OVERSHOOT = 24;
/** The send times are fully shown once the thread has moved this far. */
const FULLY_SHOWN = 34;

/**
 * Swiping the thread sideways (a horizontal trackpad scroll, a touch swipe, or a mouse drag
 * that starts outside the message text) slides your messages toward the start and reveals each
 * message's send time: beside your messages in the gutter that opens, beside a bot's in the
 * space its bubbles always keep free. On release the column springs back. The thread
 * never scrolls sideways, and vertical scrolling and text selection are left alone.
 *
 */
export function useSwipeTimes(scrollRef: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let offset = 0;
    let frame = 0;
    let wheelEnd: number | undefined;
    let drag: { x: number; y: number; id: number; on: boolean } | null = null;

    // One write per frame, straight onto the rows and their times: a transform and an opacity,
    // never a layout, and no inherited property that would restyle every message's contents.
    let pending = 0;
    let paintFrame = 0;
    const paint = () => {
      paintFrame = 0;
      const rtl = getComputedStyle(scroller).direction === "rtl";
      const shift = `${(rtl ? pending : -pending).toFixed(1)}px 0`;
      const shown = pending ? Math.min(1, pending / FULLY_SHOWN).toFixed(3) : "";
      // The times exist in the layout only while open, so they never widen the thread at rest.
      scroller.toggleAttribute("data-times-open", pending > 0);
      // Your messages slide aside to open the gutter; a bot's stay put and show their time
      // in the space kept free beside them.
      for (const row of scroller.querySelectorAll<HTMLElement>(
        ':scope > [data-message-role="user"]',
      ))
        row.style.translate = pending ? shift : "";
      for (const time of scroller.querySelectorAll<HTMLElement>(".message-swipe-time"))
        time.style.opacity = shown;
    };
    const apply = (value: number) => {
      offset = value;
      pending = value;
      if (!paintFrame) paintFrame = requestAnimationFrame(paint);
    };
    const resist = (pull: number) =>
      pull <= REACH ? pull : REACH + Math.min(OVERSHOOT, (pull - REACH) * 0.3);
    const settle = () => {
      cancelAnimationFrame(frame);
      scroller.removeAttribute("data-swiping");
      if (reduced.matches) return apply(0);
      let last = performance.now();
      const step = (now: number) => {
        const seconds = Math.min(0.1, (now - last) / 1000);
        last = now;
        const next = offset * Math.exp(-seconds * 13);
        if (next < 0.4) return apply(0);
        apply(next);
        frame = requestAnimationFrame(step);
      };
      frame = requestAnimationFrame(step);
    };
    // Toward the start of the line: left in left-to-right text, right in right-to-left.
    const inward = () => (getComputedStyle(scroller).direction === "rtl" ? 1 : -1);
    // Wide code, tables and diagrams scroll sideways themselves; leave their gestures alone.
    const insideSideScroller = (target: EventTarget | null) => {
      for (
        let element = target instanceof Element ? target : null;
        element && element !== scroller;
        element = element.parentElement
      ) {
        if (element.scrollWidth <= element.clientWidth) continue;
        const overflow = getComputedStyle(element).overflowX;
        if (overflow === "auto" || overflow === "scroll") return true;
      }
      return false;
    };

    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY) * 1.2) return;
      if (insideSideScroller(event.target)) return;
      event.preventDefault();
      cancelAnimationFrame(frame);
      scroller.setAttribute("data-swiping", "");
      const pull = Math.max(0, Math.min(REACH + OVERSHOOT, offset - inward() * event.deltaX * 0.8));
      apply(resist(pull));
      window.clearTimeout(wheelEnd);
      wheelEnd = window.setTimeout(settle, 140);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      const target = event.target as Element;
      if (target.closest("a, button, input, textarea, [contenteditable], [role='button']")) return;
      if (insideSideScroller(target)) return;
      // A mouse drag over text selects it; only a drag that starts beside the bubbles swipes.
      if (event.pointerType === "mouse" && target.closest("[data-testid='message-bubble-frame']"))
        return;
      cancelAnimationFrame(frame);
      drag = { x: event.clientX, y: event.clientY, id: event.pointerId, on: false };
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!drag) return;
      const along = (event.clientX - drag.x) * inward();
      const across = event.clientY - drag.y;
      if (!drag.on) {
        if (along > 6 && along > Math.abs(across) * 1.2 && !window.getSelection()?.toString()) {
          drag.on = true;
          scroller.setAttribute("data-swiping", "");
          scroller.setPointerCapture?.(drag.id);
        } else if (Math.abs(across) > 10) drag = null;
        return;
      }
      apply(resist(Math.max(0, along)));
    };
    const onPointerEnd = () => {
      if (drag?.on) settle();
      drag = null;
    };

    scroller.addEventListener("wheel", onWheel, { passive: false });
    scroller.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerEnd);
    window.addEventListener("pointercancel", onPointerEnd);
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(paintFrame);
      window.clearTimeout(wheelEnd);
      scroller.removeEventListener("wheel", onWheel);
      scroller.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerEnd);
      window.removeEventListener("pointercancel", onPointerEnd);
    };
  }, [scrollRef]);
}
