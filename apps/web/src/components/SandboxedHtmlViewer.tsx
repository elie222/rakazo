import { HTML_VIEWER_PATH } from "@rakazo/contracts/content-security-policy";
import { useEffect, useRef, useState } from "react";

export const PREVIEW_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'";

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

function previewDocument(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`;
  const referrer = `<meta name="referrer" content="no-referrer">`;
  return `${meta}${referrer}${PREVIEW_GUARD}${html}`;
}

/**
 * The shell at HTML_VIEWER_PATH is a network document, so it does not inherit the app's CSP the
 * way a srcdoc frame would (which would block the preview's inline scripts). It renders the posted
 * document in a nested sandboxed srcdoc frame under the shell's own CSP.
 */
export function SandboxedHtmlViewer({ html, title }: { html: string; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  // Every shell load starts empty, so each one gets the document again.
  const [loads, setLoads] = useState(0);
  useEffect(() => {
    // The sandboxed shell has an opaque origin, so there is no narrower target origin to name.
    if (loads > 0) frame.current?.contentWindow?.postMessage(previewDocument(html), "*");
  }, [loads, html]);
  return (
    <iframe
      ref={frame}
      title={title}
      src={HTML_VIEWER_PATH}
      onLoad={() => setLoads((count) => count + 1)}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      className="h-full w-full border-0 bg-white"
    />
  );
}
