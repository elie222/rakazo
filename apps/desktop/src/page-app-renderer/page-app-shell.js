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

function show(screen) {
  if (!screen) return;
  if (typeof screen.lang === "string") document.documentElement.lang = screen.lang;
  if (typeof screen.frame === "string") {
    if (typeof screen.title === "string") frame.title = screen.title;
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
  if (!data || typeof data !== "object" || !RELAYED.has(data.type)) return;
  const shown = frame.getAttribute("src");
  const reply = await bridge.message(data);
  // A reply for a page that has since been replaced is dropped.
  if (reply && frame.getAttribute("src") === shown) frame.contentWindow?.postMessage(reply, "*");
});
