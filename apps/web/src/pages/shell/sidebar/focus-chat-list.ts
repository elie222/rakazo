const RESTORE = '[data-testid="show-chat-list"]';
const SEARCH = '[data-testid="sidebar-search-trigger"]';

/** How many frames to wait for a lazily loaded shell; about a second at 60fps. */
const FOCUS_FRAMES = 60;

let pendingFrame = 0;

function focusWhenMounted(selector: string) {
  cancelAnimationFrame(pendingFrame);
  // The control that asked for the handoff owns focus until it unmounts or the user moves on.
  // A removed control hands focus back to the body, so anything else means the user left first.
  const origin = document.activeElement;
  let frames = FOCUS_FRAMES;
  const tick = () => {
    const target = document.querySelector<HTMLElement>(selector);
    if (target) {
      const active = document.activeElement;
      if (active === origin || active === document.body || active === null) target.focus();
      return;
    }
    // The destination shell renders behind a loading fallback, so the control may not exist yet.
    if (frames > 0) {
      frames -= 1;
      pendingFrame = requestAnimationFrame(tick);
    }
  };
  pendingFrame = requestAnimationFrame(tick);
}

/** A keyboard or header collapse removes the focused control; the rail's restore action takes over. */
export function focusChatListRestore() {
  focusWhenMounted(RESTORE);
}

/** Showing the list removes the restore action, so focus continues into the list's search control. */
export function focusChatList() {
  focusWhenMounted(SEARCH);
}
