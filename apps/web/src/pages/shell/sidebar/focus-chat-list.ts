const RESTORE = '[data-testid="show-chat-list"]';
const SEARCH = '[data-testid="sidebar-search-trigger"]';

function focusWhenMounted(selector: string) {
  requestAnimationFrame(() => {
    document.querySelector<HTMLElement>(selector)?.focus();
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
