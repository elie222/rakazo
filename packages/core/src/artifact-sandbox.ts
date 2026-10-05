// Same policy as the web preview: nothing loads from the network, so a script
// cannot send what it reads to a remote image or font URL.
export const SANDBOXED_ARTIFACT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'";

/**
 * Wraps bot-authored HTML with a restrictive CSP before it's handed to a
 * sandboxed viewer (a web iframe's `srcdoc`, or a native WebView's `source.html`).
 * The CSP alone isn't the isolation boundary — on web that's the iframe's
 * `sandbox="allow-scripts"` (no `allow-same-origin`); on native it's the
 * WebView never sharing the app's cookies/storage and being blocked from
 * navigating anywhere else. The CSP is a second layer on top: even within
 * that boundary, it blocks outbound network requests a script might still
 * attempt.
 */
export function withSandboxedArtifactCsp(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${SANDBOXED_ARTIFACT_CSP}">`;
  // Deliberately not regex-matching <head>/<html> to splice the meta tag in
  // "properly" — any such pattern is attacker-controlled surface (e.g. a
  // comment like `<!-- <head> -->` fools a naive match and the CSP lands
  // somewhere inert while the sandboxed document still runs scripts with no
  // policy at all). A browser (and Android/iOS WebView engines) parses a
  // leading <meta> before <!doctype>/<html> as part of the document's own
  // head regardless, so prepending is both simpler and safer.
  return `${meta}${html}`;
}
