// @vitest-environment jsdom
import { flush } from "@rakazo/core/test-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SharedReplyPage } from "./SharedReplyPage";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));

const token = "a".repeat(43);

async function settle() {
  for (let tick = 0; tick < 10; tick++) {
    await act(flush);
  }
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

async function open(path: string) {
  await act(async () =>
    root.render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(
          MemoryRouter,
          { initialEntries: [path] },
          createElement(
            Routes,
            {},
            createElement(Route, { path: "/c/:token", element: createElement(SharedReplyPage) }),
          ),
        ),
      ),
    ),
  );
  await settle();
}

it("shows the reply as plain text with its bot and date, read signed out", async () => {
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          botName: "Scout",
          text: "**not bold** <b>tag</b>\n\nSecond",
          sharedAt: "2026-11-02T10:00:00.000Z",
        }),
      ),
  );
  vi.stubGlobal("fetch", fetch);
  await open(`/c/${token}`);
  expect(fetch).toHaveBeenCalledWith(`/api/v1/replies/shared/${token}`, {
    credentials: "omit",
    referrerPolicy: "no-referrer",
    cache: "no-store",
  });
  expect(container.querySelector("h1")?.textContent).toBe("Scout");
  expect(container.querySelector("time")?.getAttribute("dateTime")).toBe(
    "2026-11-02T10:00:00.000Z",
  );
  const text = container.querySelector("[data-testid='shared-reply-text']");
  expect(text?.textContent).toBe("**not bold** <b>tag</b>\n\nSecond");
  expect(text?.querySelector("b, strong")).toBeNull();
  // React moves the page's meta tag into the document head.
  expect(document.head.querySelector("meta[name='robots']")?.getAttribute("content")).toBe(
    "noindex, nofollow",
  );
});

it("shows one not-available page for a removed link and a malformed one", async () => {
  const fetch = vi.fn(async () => new Response("", { status: 404 }));
  vi.stubGlobal("fetch", fetch);
  await open(`/c/${token}`);
  expect(container.querySelector("h1")?.textContent).toBe("This reply isn't available");
  const removed = container.innerHTML;

  await open("/c/short");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(container.innerHTML).toBe(removed);
});

it("offers a retry when the reply could not be loaded", async () => {
  const fetch = vi.fn(async () => new Response("", { status: 503 }));
  vi.stubGlobal("fetch", fetch);
  await open(`/c/${token}`);
  expect(container.querySelector("[role='alert']")?.textContent).toBe(
    "Couldn't load this reply. Try again.",
  );
});
