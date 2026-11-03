// Same policy as the web preview: nothing loads from the network, so a script
// cannot send what it reads to a remote image or font URL.
export const SANDBOXED_ARTIFACT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'";

const PLAIN_HTML_DOCTYPE = /^\s*<!doctype\s+html\s*>/i;

/**
 * The CSP is a second layer, not the isolation boundary: on web that is the iframe's
 * `sandbox="allow-scripts"` (no `allow-same-origin`); on native it is the WebView never
 * sharing the app's cookies/storage and being blocked from navigating. Within that
 * boundary the CSP still blocks outbound network requests a script might attempt.
 */
export function withSandboxedArtifactCsp(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${SANDBOXED_ARTIFACT_CSP}">`;
  const leadingDoctype = html.match(PLAIN_HTML_DOCTYPE);
  if (!leadingDoctype) return `<!DOCTYPE html>${meta}${html}`;
  const end = leadingDoctype[0].length;
  return `${html.slice(0, end)}${meta}${html.slice(end)}`;
}
