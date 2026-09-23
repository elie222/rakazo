const SANDBOXED_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:;";

/**
 * Wraps bot-authored HTML with a restrictive CSP before it's handed to an
 * iframe's `srcdoc`. The CSP alone isn't the isolation boundary — the
 * iframe's `sandbox="allow-scripts"` (no `allow-same-origin`) is, since that
 * gives the document an opaque origin that can't read this page's cookies or
 * storage or call back into Rakazo's API with credentials. The CSP is a
 * second layer on top: even within that opaque origin, block outbound
 * network requests a script might still attempt. Images and fonts are
 * limited to `data:` so opening a preview cannot fetch an author-controlled
 * HTTPS URL (which would reveal the viewer's address to that server).
 */
function withSandboxCsp(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${SANDBOXED_CSP}">`;
  // Deliberately not regex-matching <head>/<html> to splice the meta tag in
  // "properly" — any such pattern is attacker-controlled surface (e.g. a
  // comment like `<!-- <head> -->` fools a naive match and the CSP lands
  // somewhere inert while srcDoc still runs scripts with no policy at all).
  // A browser parses a leading <meta> before <!doctype>/<html> as part of the
  // document's own head regardless, so prepending is both simpler and safer.
  return `${meta}${html}`;
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
