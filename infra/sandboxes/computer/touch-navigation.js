// Touch navigation sits above noVNC's transport. It emits ordinary mouse events
// into the authenticated viewer; it never opens a second input channel.
export function createTouchNavigation({ size, point, move, button, scroll, view, now = Date.now }) {
  let cursor = { x: size().width / 2, y: size().height / 2 };
  let trackpad = false,
    zoom = 1,
    pan = { x: 0, y: 0 };
  let touches = new Map(),
    start = null,
    multi = null,
    dragging = false,
    moved = false;
  let lastTap = -Infinity,
    held = false,
    startedAt = 0;
  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
  function updateCursor(next) {
    const bounds = size();
    cursor = { x: clamp(next.x, 0, bounds.width - 1), y: clamp(next.y, 0, bounds.height - 1) };
    move(cursor);
  }
  function click(mask) {
    button(cursor, mask, true);
    button(cursor, mask, false);
  }
  function release() {
    if (dragging) button(cursor, 1, false);
    dragging = false;
  }
  function updateView() {
    const bounds = size();
    pan.x = clamp(
      pan.x,
      (-(zoom - 1) * bounds.displayWidth) / 2,
      ((zoom - 1) * bounds.displayWidth) / 2,
    );
    pan.y = clamp(
      pan.y,
      (-(zoom - 1) * bounds.displayHeight) / 2,
      ((zoom - 1) * bounds.displayHeight) / 2,
    );
    view({ zoom, pan: { ...pan }, trackpad, cursor });
  }
  function pair() {
    const [a, b] = [...touches.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, distance: Math.hypot(a.x - b.x, a.y - b.y) };
  }
  return {
    down(id, x, y) {
      touches.set(id, { x, y });
      if (touches.size === 1) {
        start = { x, y };
        startedAt = now();
        moved = false;
        held = false;
        multi = null;
        if (!trackpad) updateCursor(point(x, y));
        if (trackpad && now() - lastTap < 300) {
          button(cursor, 1, true);
          dragging = true;
        }
      } else {
        release();
        multi = { initial: pair(), previous: pair(), mode: null };
        moved = false;
      }
    },
    move(id, x, y) {
      const previous = touches.get(id);
      if (!previous) return;
      touches.set(id, { x, y });
      if (touches.size > 1) {
        const current = pair();
        if (!multi) return;
        const distance = current.distance - multi.initial.distance;
        const travel = Math.hypot(current.x - multi.initial.x, current.y - multi.initial.y);
        if (!multi.mode && Math.abs(distance) > 10) multi.mode = "zoom";
        if (!multi.mode && travel > 8) multi.mode = zoom > 1.01 ? "pan" : "scroll";
        if (multi.mode === "zoom") {
          zoom = clamp((zoom * current.distance) / Math.max(1, multi.previous.distance), 1, 4);
          updateView();
        } else if (multi.mode === "pan") {
          pan.x += current.x - multi.previous.x;
          pan.y += current.y - multi.previous.y;
          updateView();
        } else if (multi.mode === "scroll") {
          scroll(cursor, current.x - multi.previous.x, current.y - multi.previous.y);
        }
        moved ||= Boolean(multi.mode);
        multi.previous = current;
        return;
      }
      if (multi || held) return;
      const travel = Math.hypot(x - start.x, y - start.y);
      if (!moved && travel <= 5) return;
      moved = true;
      if (trackpad) {
        const bounds = size();
        updateCursor({
          x: cursor.x + ((x - previous.x) * bounds.width) / bounds.displayWidth / zoom,
          y: cursor.y + ((y - previous.y) * bounds.height) / bounds.displayHeight / zoom,
        });
      } else {
        if (!dragging) {
          button(cursor, 1, true);
          dragging = true;
        }
        updateCursor(point(x, y));
      }
    },
    hold() {
      if (touches.size === 1 && !multi && !moved && !dragging) {
        click(4);
        held = true;
      }
    },
    up(id) {
      if (!touches.has(id)) return;
      touches.delete(id);
      if (touches.size) return;
      if (multi) {
        if (!moved && now() - startedAt < 500) click(4);
      } else if (!moved && !held && !dragging) {
        click(1);
        lastTap = now();
      }
      release();
      start = null;
      multi = null;
    },
    cancel() {
      release();
      touches.clear();
      start = null;
      multi = null;
    },
    setTrackpad(value) {
      this.cancel();
      trackpad = Boolean(value);
      updateView();
    },
    recenter() {
      updateCursor({ x: size().width / 2, y: size().height / 2 });
      updateView();
    },
    resetZoom() {
      zoom = 1;
      pan = { x: 0, y: 0 };
      updateView();
    },
    resize() {
      updateView();
    },
  };
}

export function attachTouchNavigation(rfb, releaseCapture) {
  const screen = document.getElementById("screen");
  const canvas = screen.querySelector("canvas");
  if (!canvas || rfb.viewOnly) return;
  const cursor = document.createElement("div");
  cursor.id = "touch-pointer";
  cursor.hidden = true;
  cursor.innerHTML =
    '<svg width="24" height="28" viewBox="0 0 24 28" aria-hidden="true"><path d="M3 2v21l5-6 4 9 4-2-4-8h8Z" fill="white" stroke="black" stroke-width="1.5"/></svg>';
  screen.append(cursor);
  let mode = false,
    zoom = 1,
    heldButtons = 0,
    holdTimer;
  const abort = new AbortController(),
    signal = abort.signal;
  function size() {
    return {
      width: canvas.width,
      height: canvas.height,
      displayWidth: canvas.clientWidth,
      displayHeight: canvas.clientHeight,
    };
  }
  function point(x, y) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((x - rect.left) * canvas.width) / rect.width,
      y: ((y - rect.top) * canvas.height) / rect.height,
    };
  }
  function emit(type, at, extra = {}) {
    if (rfb.viewOnly) return;
    const rect = canvas.getBoundingClientRect();
    // noVNC removes its own display scale when mapping DOM events to pixels.
    // Compensate for our extra visual zoom without relying on private RFB APIs.
    canvas.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: rect.left + (at.x * canvas.clientWidth) / canvas.width,
        clientY: rect.top + (at.y * canvas.clientHeight) / canvas.height,
        buttons: (heldButtons & 1) | ((heldButtons & 4) >> 1) | ((heldButtons & 2) << 1),
        ...extra,
      }),
    );
  }
  let position = { x: canvas.width / 2, y: canvas.height / 2 };
  function showPointer(at) {
    position = at;
    const rect = canvas.getBoundingClientRect(),
      parent = screen.getBoundingClientRect();
    cursor.style.left = `${rect.left - parent.left + (at.x / canvas.width) * rect.width}px`;
    cursor.style.top = `${rect.top - parent.top + (at.y / canvas.height) * rect.height}px`;
    cursor.hidden = !mode;
  }
  function button(at, mask, down) {
    heldButtons = down ? heldButtons | mask : heldButtons & ~mask;
    emit(down ? "mousedown" : "mouseup", at, { button: mask === 4 ? 2 : mask === 2 ? 1 : 0 });
    // Synthetic canvas mouseup does not reach noVNC's window capture proxy.
    // Release its overlay explicitly or the next touch targets that overlay.
    if (!down && heldButtons === 0) releaseCapture();
  }
  const navigation = createTouchNavigation({
    size,
    point,
    move(at) {
      emit("mousemove", at);
      showPointer(at);
    },
    button,
    scroll(at, dx, dy) {
      const rect = canvas.getBoundingClientRect();
      canvas.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + (at.x * canvas.clientWidth) / canvas.width,
          clientY: rect.top + (at.y * canvas.clientHeight) / canvas.height,
          deltaX: -dx,
          deltaY: -dy,
          deltaMode: 0,
        }),
      );
    },
    view(state) {
      mode = state.trackpad;
      zoom = state.zoom;
      canvas.style.transformOrigin = "center";
      canvas.style.transform = `translate(${state.pan.x}px, ${state.pan.y}px) scale(${zoom})`;
      screen.dataset.trackpad = String(mode);
      screen.dataset.zoom = String(zoom);
      showPointer(position);
    },
  });
  // Wheel buttons are not standard DOM MouseEvent.button values. Dispatch wheel
  // events so noVNC sends the correct RFB wheel masks.
  const scrollPoint = (event) => {
    const at = point(event.clientX, event.clientY),
      rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + (at.x * canvas.clientWidth) / canvas.width,
        clientY: rect.top + (at.y * canvas.clientHeight) / canvas.height,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
      }),
    );
  };
  // Consume browser touch events before noVNC's built-in gesture recognizer.
  for (const name of ["touchstart", "touchmove", "touchend", "touchcancel"])
    screen.addEventListener(
      name,
      (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      { capture: true, passive: false, signal },
    );
  screen.addEventListener(
    "pointerdown",
    (event) => {
      if (event.pointerType === "mouse") return;
      event.preventDefault();
      screen.setPointerCapture(event.pointerId);
      navigation.down(event.pointerId, event.clientX, event.clientY);
      clearTimeout(holdTimer);
      holdTimer = setTimeout(() => navigation.hold(), 550);
    },
    { signal },
  );
  screen.addEventListener(
    "pointermove",
    (event) => {
      if (event.pointerType !== "mouse")
        navigation.move(event.pointerId, event.clientX, event.clientY);
    },
    { signal },
  );
  screen.addEventListener(
    "pointerup",
    (event) => {
      clearTimeout(holdTimer);
      if (event.pointerType !== "mouse") navigation.up(event.pointerId);
    },
    { signal },
  );
  screen.addEventListener(
    "pointercancel",
    () => {
      clearTimeout(holdTimer);
      navigation.cancel();
    },
    { signal },
  );
  // Hardware mouse coordinates also remain accurate after a touch zoom.
  for (const name of ["mousedown", "mousemove", "mouseup"])
    screen.addEventListener(
      name,
      (event) => {
        if (!event.isTrusted || zoom === 1) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        emit(name, point(event.clientX, event.clientY), {
          button: event.button,
          buttons: event.buttons,
        });
      },
      { capture: true, signal },
    );
  screen.addEventListener(
    "wheel",
    (event) => {
      if (event.isTrusted && zoom !== 1) {
        event.preventDefault();
        event.stopImmediatePropagation();
        scrollPoint(event);
      }
    },
    { capture: true, passive: false, signal },
  );
  window.addEventListener(
    "message",
    (event) => {
      if (event.source !== window.parent || event.data?.type !== "cadre:computer-navigation")
        return;
      if (event.data.action === "trackpad" && typeof event.data.enabled === "boolean")
        navigation.setTrackpad(event.data.enabled);
      if (event.data.action === "recenter") navigation.recenter();
      if (event.data.action === "resetZoom") navigation.resetZoom();
    },
    { signal },
  );
  const resize = new ResizeObserver(() => navigation.resize());
  resize.observe(screen);
  window.addEventListener("blur", () => navigation.cancel(), { signal });
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.hidden) navigation.cancel();
    },
    { signal },
  );
  rfb.addEventListener("disconnect", () => {
    clearTimeout(holdTimer);
    navigation.cancel();
    resize.disconnect();
    abort.abort();
    cursor.remove();
  });
  // The sandboxed frame has an opaque origin; the parent validates event.source.
  window.parent.postMessage({ type: "cadre:computer-navigation-ready" }, "*");
}
