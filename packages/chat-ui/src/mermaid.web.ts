import type { ResolvedAppearance } from "@rakazo/ui-tokens";
import { tokensForAppearance } from "@rakazo/ui-tokens";
import { useEffect, useState, useSyncExternalStore } from "react";
import { chatMermaidConfig } from "./mermaid";

type Mermaid = typeof import("mermaid")["default"];

// Mermaid is large. It loads the first time a message contains a diagram, never with the chat.
let mermaidLoad: Promise<Mermaid> | undefined;

function loadMermaid(): Promise<Mermaid> {
  mermaidLoad ??= import("mermaid").then(
    (module) => module.default,
    (error: unknown) => {
      // A failed chunk load is retried by the next diagram instead of failing every later one.
      mermaidLoad = undefined;
      throw error;
    },
  );
  return mermaidLoad;
}

// Mermaid keeps one global config, so one diagram renders at a time with its own theme.
let renderQueue: Promise<unknown> = Promise.resolve();

function inTurn<T>(task: () => Promise<T>): Promise<T> {
  const run = renderQueue.then(task, task);
  renderQueue = run.catch(() => undefined);
  return run;
}

const MAX_RENDERED = 64;
// Source that does not parse is remembered as null, so it is not parsed again on every redraw.
const rendered = new Map<string, string | null>();
let renderCount = 0;

function renderKey(source: string, appearance: ResolvedAppearance) {
  return `${appearance}\n${source}`;
}

function remember(key: string, svg: string | null) {
  rendered.delete(key);
  rendered.set(key, svg);
  if (rendered.size > MAX_RENDERED) {
    const oldest = rendered.keys().next().value;
    if (oldest !== undefined) rendered.delete(oldest);
  }
}

/** The diagram as SVG markup, or null when the source is not a diagram Mermaid can draw. */
export function renderMermaidSvg(
  source: string,
  appearance: ResolvedAppearance,
): Promise<string | null> {
  const key = renderKey(source, appearance);
  const known = rendered.get(key);
  if (known !== undefined) return Promise.resolve(known);
  return inTurn(async () => {
    const mermaid = await loadMermaid();
    mermaid.initialize(chatMermaidConfig(tokensForAppearance(appearance), appearance));
    const id = `rk-mermaid-${++renderCount}`;
    let svg: string | null = null;
    try {
      if (await mermaid.parse(source, { suppressErrors: true })) {
        svg = (await mermaid.render(id, source)).svg;
      }
    } catch {
      svg = null;
    } finally {
      // Mermaid measures in a scratch node on <body>; a throw can leave it behind.
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    }
    remember(key, svg);
    return svg;
  });
}

function readAppearance(): ResolvedAppearance {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function subscribeAppearance(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

/**
 * The SVG for a diagram in the page's current theme. Undefined while it renders and null when it
 * cannot be drawn; the caller shows the code block in both cases, so the source is never lost.
 */
export function useMermaidSvg(source: string): string | null | undefined {
  const appearance = useSyncExternalStore<ResolvedAppearance>(
    subscribeAppearance,
    readAppearance,
    () => "dark",
  );
  const key = renderKey(source, appearance);
  const [result, setResult] = useState<{ key: string; svg: string | null }>();
  useEffect(() => {
    let current = true;
    renderMermaidSvg(source, appearance).then(
      (svg) => {
        if (current) setResult({ key, svg });
      },
      () => {
        if (current) setResult({ key, svg: null });
      },
    );
    return () => {
      current = false;
    };
  }, [source, appearance, key]);
  if (result?.key === key) return result.svg;
  return rendered.get(key);
}
