const SANDBOXED_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https:; font-src data: https:;";

/**
 * Wraps bot-authored HTML with a restrictive CSP before it's handed to an
 * iframe's `srcdoc`. The CSP alone isn't the isolation boundary — the
 * iframe's `sandbox="allow-scripts"` (no `allow-same-origin`) is, since that
 * gives the document an opaque origin that can't read this page's cookies or
 * storage or call back into Rakazo's API with credentials. The CSP is a
 * second layer on top: even within that opaque origin, block outbound
 * network requests a script might still attempt.
 */
function withSandboxCsp(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${SANDBOXED_CSP}">`;
  const headMatch = /<head[^>]*>/i.exec(html);
  const scriptOrStyleMatch = /<(script|style)[^>]*>/i.exec(html);
  // Only trust a matched <head> if it isn't inside an earlier <script>/<style>
  // block (e.g. a string literal like `"<head>"`) — otherwise the meta tag
  // would land somewhere inert and the CSP would silently never apply.
  const headIsReal =
    headMatch && (!scriptOrStyleMatch || headMatch.index < scriptOrStyleMatch.index);
  if (headIsReal) return html.replace(headMatch[0], (tag) => `${tag}${meta}`);
  const htmlMatch = /<html[^>]*>/i.exec(html);
  const htmlIsReal =
    htmlMatch && (!scriptOrStyleMatch || htmlMatch.index < scriptOrStyleMatch.index);
  if (htmlIsReal) {
    return html.replace(htmlMatch[0], (tag) => `${tag}<head>${meta}</head>`);
  }
  return `<head>${meta}</head>${html}`;
}

export function SandboxedHtmlViewer({ html, title }: { html: string; title: string }) {
  return (
    <iframe
      title={title}
      srcDoc={withSandboxCsp(html)}
      sandbox="allow-scripts"
      className="h-full w-full border-0 bg-white"
    />
  );
}
