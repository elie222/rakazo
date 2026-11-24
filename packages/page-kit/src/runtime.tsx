import type { PageSectionAnchor } from "@rakazo/contracts";
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
  reviewAnchorOccurrence?: number;
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

/** Report content height for printing and the viewport's scrollable extent for previews. */
function reportHeight(host: HTMLElement) {
  const body = document.body;
  let previous: { height: number; scrollHeight: number; width: number } | undefined;
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const height = body.scrollHeight;
      // An absolutely positioned descendant can overflow the document without overflowing body.
      const scrollHeight = document.scrollingElement?.scrollHeight ?? height;
      const width = window.innerWidth;
      // Interactive viewers also use the report to keep their print width current.
      if (
        previous &&
        height === previous.height &&
        scrollHeight === previous.scrollHeight &&
        width === previous.width
      )
        return;
      previous = { height, scrollHeight, width };
      window.parent?.postMessage({ type: "rakazo-page:height", height, scrollHeight }, "*");
    });
  };
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(schedule).observe(body);
  // Positioned descendants can change the scroll range without resizing the body box.
  new MutationObserver(schedule).observe(host, {
    childList: true,
    characterData: true,
    subtree: true,
    attributes: true,
  });
  // Resources and CSS motion can finish changing the layout without a DOM mutation.
  for (const event of [
    "load",
    "error",
    "loadedmetadata",
    "transitionend",
    "transitioncancel",
    "animationend",
    "animationcancel",
  ]) {
    host.addEventListener(event, schedule, true);
  }
  document.fonts?.addEventListener("loadingdone", schedule);
  addEventListener("load", schedule);
  addEventListener("resize", schedule);
  schedule();
}

/** Count same-name headings before filtering visibility so a reveal keeps their anchors stable. */
function reportSections(host: HTMLElement, anchor?: string, anchorOccurrence?: number) {
  let previous = "";
  let destination = anchor;
  let scheduled = false;
  const report = () => {
    const headings = [...host.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]")].slice(0, 80);
    const occurrences = new Map<string, number>();
    const anchors: PageSectionAnchor[] = [];
    for (const heading of headings) {
      const section = heading.textContent?.replace(/\s+/g, " ").trim().slice(0, 200).trimEnd();
      if (!section) continue;
      const sectionOccurrence = occurrences.get(section) ?? 0;
      occurrences.set(section, sectionOccurrence + 1);
      if (!heading.getClientRects().length) continue;
      const { visibility } = getComputedStyle(heading);
      if (visibility === "hidden" || visibility === "collapse") continue;
      anchors.push({ section, sectionOccurrence });
      if (
        section === destination &&
        (anchorOccurrence === undefined || anchorOccurrence === sectionOccurrence)
      ) {
        heading.scrollIntoView();
        destination = undefined;
      }
    }
    const next = JSON.stringify(anchors);
    if (next === previous) return;
    previous = next;
    // Older clients read the label list; newer clients use the paired anchors.
    window.parent?.postMessage(
      { type: "rakazo-page:sections", sections: anchors.map(({ section }) => section), anchors },
      "*",
    );
  };
  new MutationObserver(() => {
    if (!previous) {
      report();
      return;
    }
    if (scheduled) return;
    scheduled = true;
    // A review picker can wait briefly for changes. Coalesce animations without missing a reveal.
    setTimeout(() => {
      scheduled = false;
      report();
    }, 100);
  }).observe(host, { childList: true, characterData: true, subtree: true, attributes: true });
}

function mount(boot: PageBoot) {
  document.documentElement.dataset.theme = boot.theme === "light" ? "light" : "dark";
  const host =
    document.getElementById("root") ?? document.body.appendChild(document.createElement("div"));
  reportHeight(host);
  if (boot.review) reportSections(host, boot.reviewAnchor, boot.reviewAnchorOccurrence);
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
