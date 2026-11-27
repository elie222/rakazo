// The shell of an installed page app: shows the page's sandboxed frame and passes on what the
// page asks for. The main process checks every message and holds everything the page reaches.
const bridge = window.rakazoPageApp;
const frame = document.getElementById("page");
const notice = document.getElementById("notice");
const RELAYED = new Set([
  "rakazo-page:state",
  "rakazo-page:open-link",
  "rakazo-page:copy",
  "rakazo-page:ask",
  "rakazo-page:notify",
]);
// As in the web viewer: the guard placed first in the page reports each trusted click or key with
// a key only it knows, and a click in the frame also activates this shell, which the page cannot
// fake. A message right after one carries it, so the app acts once per click or key.
const GESTURE_WINDOW_MS = 1000;
let gestureKey = "";
let gesture = 0;
let gestureAt = 0;

function show(screen) {
  if (!screen) return;
  if (typeof screen.lang === "string") document.documentElement.lang = screen.lang;
  if (typeof screen.frame === "string") {
    if (typeof screen.title === "string") frame.title = screen.title;
    if (typeof screen.gestureKey === "string" && screen.gestureKey !== gestureKey) {
      gestureKey = screen.gestureKey;
      gesture = 0;
    }
    notice.hidden = true;
    frame.hidden = false;
    if (frame.getAttribute("src") !== screen.frame) frame.setAttribute("src", screen.frame);
  } else if (typeof screen.message === "string") {
    frame.hidden = true;
    frame.removeAttribute("src");
    notice.textContent = screen.message;
    notice.hidden = false;
  }
}

bridge.onScreen(show);
bridge.ready().then(show);

window.addEventListener("message", async (event) => {
  if (event.source !== frame.contentWindow) return;
  const data = event.data;
  if (!data || typeof data !== "object") return;
  const active = navigator.userActivation ? navigator.userActivation.isActive : false;
  if (data.type === "rakazo-page:gesture") {
    if (gestureKey && data.key === gestureKey && active) {
      gesture += 1;
      gestureAt = Date.now();
    }
    return;
  }
  if (!RELAYED.has(data.type)) return;
  const fresh =
    active && gesture > 0 && Date.now() - gestureAt <= GESTURE_WINDOW_MS
      ? `${gestureKey}:${gesture}`
      : null;
  const shown = frame.getAttribute("src");
  const reply = await bridge.message({ ...data, gesture: fresh }, shown);
  // A reply for a page that has since been replaced is dropped.
  if (reply && frame.getAttribute("src") === shown) frame.contentWindow?.postMessage(reply, "*");
});
