import { useObjectUrl } from "../lib/use-object-url";

/**
 * Renders a PDF via the browser's own built-in PDF viewer (Chrome, Edge and
 * Firefox all support this) — no bundled PDF.js needed. Unlike bot-authored
 * HTML, a PDF isn't executing inside Rakazo's own script context: the
 * browser's native viewer handles it in its own process/sandbox, so this
 * doesn't need the same srcdoc/CSP treatment as `SandboxedHtmlViewer`.
 */
export function PdfViewer({ bytes, title }: { bytes: Uint8Array; title: string }) {
  const url = useObjectUrl(bytes, "application/pdf");
  if (!url) return null;
  return <iframe title={title} src={url} className="h-full w-full border-0" />;
}
