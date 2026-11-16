export const message =
  "Do not hand-write a timer or an add/remove listener pair in a component or hook. Use useTimeout(callback, ms | null, restartKey) or useNow(ms | null) from @rakazo/chat-ui/hooks, and on web useEventListener(target, type, handler, options) from apps/web/src/lib/use-event-listener.ts: they call the latest callback, clean up on unmount and when their inputs change, and never fire after unmount. A data read waits for the server's change signal rather than a timer.";

export const include = [
  "apps/web/src/**/*.{ts,tsx}",
  "apps/mobile/{app,components,lib}/**/*.{ts,tsx}",
];

export const exclude = [
  "**/*.{test,spec}.*",
  "**/*{.,-}test-{support,helpers}.*",
  "**/test-*.*",
  "apps/web/src/lib/use-event-listener.ts",
];

// The add, not the remove: a listener never removed is the leak the hook prevents. Native
// subscriptions (app state, back button) and abort signals have no hook to move to.
const CALL =
  /(?<![\w$.])(?:window\.|globalThis\.)?(?:setTimeout|setInterval)\s*\(|(?<!(?:\b(?:AppState|BackHandler|Linking|Keyboard|Dimensions|[sS]ignal)|\))\s*\.\s*)\baddEventListener\s*\(/g;
const EFFECTS = /^import \{[^}]*\buse(?:Layout)?Effect\b[^}]*\} from "react";/m;
// Script text sent into a sandboxed frame or web view runs there, where no React hook can.
const TEMPLATE = /`(?:[^`\\]|\\.)*`/g;

/** A component (.tsx) or a module that runs React effects; stores and plain helpers keep their timers. */
export function count(text, file) {
  if (!file.endsWith(".tsx") && !EFFECTS.test(text)) return [];
  const code = text.replace(TEMPLATE, (literal) => literal.replace(/[^\n]/g, " "));
  const hits = [];
  for (const match of code.matchAll(CALL)) {
    const line = text.slice(0, match.index).split("\n").length;
    hits.push({ line, text: text.split("\n")[line - 1].trim() });
  }
  return hits;
}
