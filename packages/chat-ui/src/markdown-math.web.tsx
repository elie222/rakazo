import type katex from "katex";
import { useEffect, useMemo, useState } from "react";

type Katex = typeof katex;

let loaded: Katex | undefined;
let loading: Promise<Katex | undefined> | undefined;

function loadMath() {
  loading ??= import("katex").then(
    ({ default: renderer }) => {
      loaded = renderer;
      return renderer;
    },
    () => {
      // Keep the source readable and let a later equation retry the chunk.
      loading = undefined;
      return undefined;
    },
  );
  return loading;
}

function renderMath(renderer: Katex | undefined, tex: string, displayMode: boolean) {
  if (!renderer || !tex) return undefined;
  try {
    return renderer.renderToString(tex, {
      displayMode,
      output: "mathml",
      trust: false,
      maxSize: 20,
      maxExpand: 250,
    });
  } catch (error) {
    if (error instanceof renderer.ParseError || error instanceof RangeError) return undefined;
    throw error;
  }
}

export function MarkdownMath({
  tex,
  source,
  display,
}: {
  tex: string;
  source: string;
  display: boolean;
}) {
  const [renderer, setRenderer] = useState(loaded);
  useEffect(() => {
    if (renderer) return;
    let current = true;
    void loadMath().then((next) => {
      if (current && next) setRenderer(next);
    });
    return () => {
      current = false;
    };
  }, [renderer]);

  const html = useMemo(() => renderMath(renderer, tex, display), [renderer, tex, display]);
  const className = display ? "rk-chat-math-display" : undefined;
  // KaTeX escapes TeX input and blocks link, image and HTML commands with trust disabled.
  return html ? (
    // biome-ignore lint/security/noDangerouslySetInnerHtml: Only the trusted renderer emits markup here.
    <span className={className} dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <span className={className}>{source}</span>
  );
}
