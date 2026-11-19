import type { ComponentType } from "react";
import * as React from "react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  PAGE_GLOBALS,
  PAGE_HELPERS,
  PAGE_HOOKS,
  PAGE_KIT_COMPONENTS,
  PAGE_KIT_MODULE,
} from "./components.js";
import { ErrorBoundary, ErrorPanel, ErrorTitle } from "./kit/boundary.js";
import { helpers, kit } from "./kit/index.js";
import { PageLanguage } from "./kit/labels.js";
import { PAGE_STYLES } from "./kit/styles.js";

/** What the host's boot script passes to `RakazoPage.mount`; `code` comes from `pageViewerCode`. */
type PageBoot = {
  code: string;
  theme: "light" | "dark";
  errorTitle: string;
  lang?: string;
  review?: boolean;
  reviewAnchor?: string;
};

type PageFactory = (exports: { default?: unknown }, ...globals: unknown[]) => void;

declare global {
  interface Window {
    RakazoPage?: { mount: (boot: PageBoot) => void };
    __rakazoPageFactory?: PageFactory;
  }
}

/**
 * The policy allows inline scripts but not eval, so the compiled page runs as an inline script
 * that hands back a factory taking the page's globals as arguments. An import of React or the
 * kit, which the check allows, compiles to a require of what is already in scope. The page runs
 * in an inner function, so its own `const Steps` replaces the kit's instead of failing to load.
 */
function loadPage(code: string): ComponentType {
  const script = document.createElement("script");
  script.text = `window.__rakazoPageFactory=function(exports,require,${PAGE_GLOBALS.join(",")}){(function(){${code}\n})()};`;
  document.head.append(script);
  script.remove();
  const factory = window.__rakazoPageFactory;
  delete window.__rakazoPageFactory;
  if (typeof factory !== "function") throw new Error("The page's code could not be run.");
  const exports: { default?: unknown } = {};
  const modules: Record<string, unknown> = {
    react: React,
    [PAGE_KIT_MODULE]: { ...kit, ...helpers },
  };
  factory(
    exports,
    (name: string) => modules[name],
    React,
    React.Fragment,
    ...PAGE_HOOKS.map((name) => HOOKS[name]),
    ...PAGE_HELPERS.map((name) => helpers[name]),
    ...PAGE_KIT_COMPONENTS.map((name) => kit[name]),
  );
  if (typeof exports.default !== "function") {
    throw new Error("The page has no default export component.");
  }
  return exports.default as ComponentType;
}

const HOOKS: Record<(typeof PAGE_HOOKS)[number], unknown> = {
  useState,
  useMemo,
  useEffect,
  useRef,
  useCallback,
  useReducer,
};

/** The public viewer sizes its frame to the page, so the page scrolls and prints as a whole. */
function reportHeight() {
  const post = () =>
    window.parent?.postMessage(
      { type: "rakazo-page:height", height: document.body.scrollHeight },
      "*",
    );
  if (typeof ResizeObserver === "undefined") {
    // Without it the page still reports its height once drawn, and again on each resize.
    addEventListener("load", post);
    addEventListener("resize", post);
    setTimeout(post, 0);
    return;
  }
  new ResizeObserver(post).observe(document.body);
}

/** Section names are display data from this rendered revision. */
function reportSections(host: HTMLElement, anchor?: string) {
  let previous = "";
  let destination = anchor;
  const report = () => {
    const headings = [...host.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]")]
      .slice(0, 80)
      .filter((heading) => heading.getClientRects().length > 0);
    const labels = headings.map((heading) =>
      heading.textContent?.replace(/\s+/g, " ").trim().slice(0, 200),
    );
    const index = destination === undefined ? -1 : labels.indexOf(destination);
    if (index >= 0) {
      headings[index]?.scrollIntoView();
      destination = undefined;
    }
    const sections = labels.filter(Boolean);
    const next = JSON.stringify(sections);
    if (next === previous) return;
    previous = next;
    window.parent?.postMessage({ type: "rakazo-page:sections", sections }, "*");
  };
  new MutationObserver(report).observe(host, {
    childList: true,
    characterData: true,
    subtree: true,
  });
}

function mount(boot: PageBoot) {
  document.documentElement.dataset.theme = boot.theme === "light" ? "light" : "dark";
  reportHeight();
  const host =
    document.getElementById("root") ?? document.body.appendChild(document.createElement("div"));
  if (boot.review) reportSections(host, boot.reviewAnchor);
  const root = createRoot(host);
  let Page: ComponentType;
  try {
    Page = loadPage(boot.code);
  } catch (error) {
    root.render(
      <ErrorPanel
        title={boot.errorTitle}
        message={error instanceof Error ? error.message : String(error)}
      />,
    );
    return;
  }
  root.render(
    <ErrorTitle.Provider value={boot.errorTitle}>
      <PageLanguage.Provider value={typeof boot.lang === "string" ? boot.lang : undefined}>
        <ErrorBoundary>
          <Page />
        </ErrorBoundary>
      </PageLanguage.Provider>
    </ErrorTitle.Provider>,
  );
}

// Styled from the head, before the body exists, so the frame never paints an unstyled white.
const style = document.createElement("style");
style.textContent = PAGE_STYLES;
document.head.append(style);

window.RakazoPage = { mount };
