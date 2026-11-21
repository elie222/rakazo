const RESTORE = '[data-testid="show-chat-list"]';
const SEARCH = '[data-testid="sidebar-search-trigger"]';

/** How many frames to wait for a lazily loaded shell; about a second at 60fps. */
const FOCUS_FRAMES = 60;

function focusWhenMounted(selector: string, frames = FOCUS_FRAMES) {
  requestAnimationFrame(() => {
    const target = document.querySelector<HTMLElement>(selector);
    if (target) {
      target.focus();
      return;
    }
    // The destination shell renders behind a loading fallback, so the control may not exist yet.
    if (frames > 0) focusWhenMounted(selector, frames - 1);
  });
}

/** A keyboard or header collapse removes the focused control; the rail's restore action takes over. */
export function focusChatListRestore() {
  focusWhenMounted(RESTORE);
}

/** Showing the list removes the restore action, so focus continues into the list's search control. */
export function focusChatList() {
  focusWhenMounted(SEARCH);
}
