const KEY = "cadre.taskDraft";
const MAX_LENGTH = 2000;
// Drafts stay in this tab through the OAuth redirect. They are never auto-sent.
export function captureTaskDraft(pathname: string, search: string) {
  if (!/^\/app(?:\/|$)/.test(pathname)) return;
  const value = new URLSearchParams(search).get("task");
  if (value?.trim()) {
    try {
      sessionStorage.setItem(KEY, value.slice(0, MAX_LENGTH));
    } catch {
      /* Storage may be disabled. */
    }
  }
}
export function readTaskDraft() {
  try {
    return (sessionStorage.getItem(KEY) ?? "").slice(0, MAX_LENGTH);
  } catch {
    return "";
  }
}
export function clearTaskDraft() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* Storage may be disabled. */
  }
}
