export const message =
  "Do not hand-write a save's state: a useState named saving, pending, busy or submitting with its own try/catch and refetch. Save with useSave, from apps/web/src/lib/query/query.ts on web and from apps/mobile/lib/query/query.ts on mobile, and write through the client its save receives, so pending, the failure, double clicks, the reads the save makes out of date and answers that arrive after the screen or its space has gone are handled in one place.";

export const include = [
  "apps/web/src/**/*.{ts,tsx}",
  "apps/mobile/{app,components,lib}/**/*.{ts,tsx}",
];

export const exclude = ["**/*.{test,spec}.*"];

// The flag itself or a named one (`voiceBusy`, `savingRoutine`, `namePending`). `pendingDelete`
// and `pendingAttachments` hold what is waiting, not whether a request is in flight.
const STATE =
  /\bconst \[\s*(?:(?:saving|busy|submitting)(?:[A-Z]\w*)?|\w*[a-z](?:Saving|Busy|Submitting)|(?:\w*[a-z]P|p)ending),\s*(set\w+)\s*\]\s*=\s*useState\b/g;

export function count(text) {
  const hits = [];
  for (const match of text.matchAll(STATE)) {
    const [statement, setter] = match;
    // A flag only handed to a child (`onBusyChange={setVaultBusy}`) reports that child's save.
    if (!text.includes(`${setter}(`)) continue;
    hits.push({ line: text.slice(0, match.index).split("\n").length, text: statement });
  }
  return hits;
}
