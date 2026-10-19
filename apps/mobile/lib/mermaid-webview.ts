import type { ChatMermaidConfig } from "@rakazo/chat-ui/mermaid";

/** Served by the API (`apps/api/src/diagram-script.ts`), so the app does not bundle Mermaid. */
export const DIAGRAM_SCRIPT_PATH = "/api/v1/assets/mermaid.js";

/** Long enough for a first, uncached download of Mermaid on a slow connection. */
export const DIAGRAM_TIMEOUT_MS = 20_000;

export const MAX_DIAGRAM_HEIGHT = 10_000;

export type DiagramMessage = { type: "drawn"; height: number } | { type: "failed" };

export function diagramScriptUrl(apiBase: string): string {
  return new URL(DIAGRAM_SCRIPT_PATH, apiBase).href;
}

function escapeAttribute(value: string) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * The page a diagram is drawn in. Its policy allows exactly one script, Mermaid from the
 * user's own server, and no requests, frames, forms, or fonts; it is loaded as `about:blank`
 * HTML, so it has none of the app's cookies or storage either.
 */
export function diagramDocument(scriptUrl: string): string {
  const policy = [
    "default-src 'none'",
    `script-src ${scriptUrl}`,
    // Mermaid styles its SVG with an inline <style> element.
    "style-src 'unsafe-inline'",
    "img-src data:",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(policy)}">`,
    // A wide diagram scrolls sideways; the WebView is as tall as the diagram, so never down.
    "<style>html,body{margin:0;padding:0;background:transparent;overflow-x:auto;overflow-y:hidden}",
    "#diagram svg{display:block;max-width:100%;height:auto;margin:0 auto}</style>",
    `<script src="${escapeAttribute(scriptUrl)}"></script>`,
    '</head><body><div id="diagram"></div></body></html>',
  ].join("");
}

/**
 * Runs in the page once it loads (native injection, which the page's policy does not block).
 * Posts `drawn` with the height to give the WebView, or `failed` so the app keeps the code block.
 */
export function diagramBootScript(source: string, config: ChatMermaidConfig): string {
  return `(function () {
  var post = function (message) {
    window.ReactNativeWebView.postMessage(JSON.stringify(message));
  };
  var fail = function () { post({ type: "failed" }); };
  var source = ${JSON.stringify(source)};
  var mermaid = window.mermaid;
  if (!mermaid) return fail();
  try {
    mermaid.initialize(${JSON.stringify(config)});
  } catch (error) {
    return fail();
  }
  mermaid.parse(source, { suppressErrors: true }).then(function (valid) {
    if (!valid) return fail();
    return mermaid.render("rk-mermaid", source).then(function (result) {
      var root = document.getElementById("diagram");
      root.innerHTML = result.svg;
      // Shrinks to fit the screen, but not below 80% of its drawn size, so its text stays legible.
      var svg = root.querySelector("svg");
      var box = svg && svg.viewBox && svg.viewBox.baseVal;
      if (box && box.width > 0) svg.style.minWidth = Math.ceil(box.width * 0.8) + "px";
      var report = function () {
        post({ type: "drawn", height: Math.ceil(root.getBoundingClientRect().height) });
      };
      report();
      if (window.ResizeObserver) new ResizeObserver(report).observe(root);
    });
  }).catch(fail);
})();
true;`;
}

export function parseDiagramMessage(data: string): DiagramMessage | null {
  try {
    const message = JSON.parse(data) as { type?: unknown; height?: unknown };
    if (message.type === "failed") return { type: "failed" };
    if (
      message.type === "drawn" &&
      typeof message.height === "number" &&
      Number.isFinite(message.height) &&
      message.height > 0
    ) {
      if (message.height > MAX_DIAGRAM_HEIGHT) return { type: "failed" };
      return { type: "drawn", height: message.height };
    }
  } catch {
    // Not a message this page sends.
  }
  return null;
}
