export const PAGE_DIALOG_DESKTOP_NOTE =
  "Answer it with computer_act, or request_takeover if the user should decide. Do not repeat the step that opened it.";

export const PAGE_DIALOG_NOTE =
  "Use request_takeover so the user can answer it. Do not repeat the step that opened it.";

export const PAGE_STEP_FAILED_DESKTOP_NOTE =
  "Page browser could not complete this step. A failed step is not a reason to stop: inspect the current state with computer_act, then try another route, such as another control, another way through the site or a direct URL. Use request_takeover only when the step needs the user. Do not replay completed or uncertain actions.";

export const PAGE_STEP_FAILED_NOTE =
  "Page browser could not complete this step. The computer or its browser may still be starting, so call browser_snapshot again to check the page. Use request_takeover only if it keeps failing. Do not replay completed or uncertain actions.";
