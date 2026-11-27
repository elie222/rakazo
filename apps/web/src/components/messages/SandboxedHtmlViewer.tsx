import { HTML_VIEWER_PATH } from "@rakazo/contracts/content-security-policy";
import { useEffect, useRef, useState } from "react";
import { useEventListener } from "../../lib/use-event-listener";

export const PREVIEW_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src data: blob:; font-src data:; form-action 'none'; base-uri 'none'";

const PREVIEW_GUARD = `<script>
document.addEventListener("click", (event) => {
  const target = event.target;
  const link = target instanceof Element ? target.closest("a[href]") : null;
  if (!link) return;
  const href = link.getAttribute("href") ?? "";
  event.preventDefault();
  if (href.startsWith("#")) location.hash = href;
}, true);
document.addEventListener("submit", (event) => event.preventDefault(), true);
</script>`;

const SCROLL_PREVIEW = "rakazo-page:scroll-preview";
const SCROLL_PREVIEW_GUARD = `<style>
@media (pointer: fine) {
  :root { overflow-anchor: none; scrollbar-width: none; }
  :root::-webkit-scrollbar { display: none; }
}
</style><script>
(() => {
  const shell = parent;
  const finePointer = matchMedia("(pointer: fine)");
  const scroll = window.scrollTo.bind(window);
  addEventListener("message", (event) => {
    const data = event.data;
    if (finePointer.matches && event.source === shell && data?.type === "${SCROLL_PREVIEW}" && Number.isFinite(data.top) && data.top >= 0) {
      scroll({ top: data.top, behavior: "instant" });
    }
  });
})();
</script>`;

function previewDocument(html: string, scrollable: boolean): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`;
  const referrer = `<meta name="referrer" content="no-referrer">`;
  return `${meta}${referrer}${PREVIEW_GUARD}${scrollable ? SCROLL_PREVIEW_GUARD : ""}${html}`;
}

function sendPreviewScroll(frame: HTMLIFrameElement | null, top: number) {
  frame?.contentWindow?.postMessage({ type: SCROLL_PREVIEW, top: Math.max(0, top) }, "*");
}

/**
 * The shell at HTML_VIEWER_PATH is a network document, so it does not inherit the app's CSP the
 * way a srcdoc frame would (which would block the preview's inline scripts). It renders the posted
 * document in a nested sandboxed srcdoc frame under the shell's own CSP.
 */
export function SandboxedHtmlViewer({
  html,
  title,
  className = "bg-white",
  previewScrollTop,
  onFrameMessage,
}: {
  html: string;
  title: string;
  className?: string;
  /** For a Page card, scroll the rendered document to match the card's native scroll position. */
  previewScrollTop?: number;
  /**
   * Messages the shown document sends up through the viewer shell; `answer` posts back down, and
   * `focused` says whether this frame holds the app's focus as the message arrives.
   */
  onFrameMessage?: (data: unknown, answer: (message: object) => void, focused: boolean) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  // Every shell load starts empty, so each one gets the document again.
  const [loads, setLoads] = useState(0);
  const scrollable = previewScrollTop !== undefined;
  useEffect(() => {
    // The sandboxed shell has an opaque origin, so there is no narrower target origin to name.
    if (loads > 0)
      frame.current?.contentWindow?.postMessage(previewDocument(html, scrollable), "*");
  }, [loads, html, scrollable]);
  useEffect(() => {
    if (previewScrollTop !== undefined) sendPreviewScroll(frame.current, previewScrollTop);
  }, [previewScrollTop]);
  useEventListener(onFrameMessage || scrollable ? window : null, "message", (event) => {
    // Only this viewer's own frame speaks for its document.
    if (event.source !== frame.current?.contentWindow) return;
    // A newly mounted document may have missed the last scroll message during navigation.
    if (previewScrollTop !== undefined && event.data?.type === "rakazo-page:height") {
      sendPreviewScroll(frame.current, previewScrollTop);
    }
    onFrameMessage?.(
      event.data,
      (message) => frame.current?.contentWindow?.postMessage(message, "*"),
      document.activeElement === frame.current,
    );
  });
  return (
    <iframe
      ref={frame}
      title={title}
      src={HTML_VIEWER_PATH}
      onLoad={() => setLoads((count) => count + 1)}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      // The viewer shell declares no colour scheme. Against a dark app the browser would paint
      // the frame opaque white until the document draws; matching schemes keep it see-through.
      className={`h-full w-full border-0 [color-scheme:light] ${className}`}
    />
  );
}
