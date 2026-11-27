// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import PageAppPage from "./PageAppPage";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join("") }),
}));
vi.mock("../lib/pages/pages", () => ({
  useReviewedPageContent: () => undefined,
  usePageDocument: () => ({ document: "<p>page</p>", failed: false, retry: () => undefined }),
}));
vi.mock("../lib/pages/page-state", () => ({
  usePageStateSaver: () => ({ save: () => undefined, failed: false }),
}));
vi.mock("../lib/query/follow-stream", () => ({ followStream: () => () => undefined }));
const read = vi.hoisted(() => ({ fails: false }));
vi.mock("../lib/query/query", () => ({
  useSpaceQueries: () => ({
    notifications: { subscribe: { call: () => undefined } },
    pages: {
      get: {
        queryOptions: ({ input }: { input: { pageId: string } }) => ({
          queryKey: ["page", input.pageId],
          queryFn: async () => {
            if (read.fails) throw Object.assign(new Error("gone"), { code: "NOT_FOUND" });
            return { id: input.pageId, title: "Trip plan" };
          },
        }),
      },
    },
  }),
}));
vi.mock("../components/pages/PageFrame", () => ({
  PageFrame: ({ title }: { title: string }) => createElement("h1", {}, title),
}));

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
beforeEach(() => {
  read.fails = false;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.head.innerHTML =
    '<link rel="manifest" href="/site.webmanifest"><link rel="apple-touch-icon" href="/apple-touch-icon.png">';
  document.title = "Rakazo";
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function open(path: string) {
  await act(async () =>
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          MemoryRouter,
          { initialEntries: [path] },
          createElement(
            Routes,
            {},
            createElement(Route, { path: "/page/:pageId", element: createElement(PageAppPage) }),
          ),
        ),
      ),
    ),
  );
  await vi.waitFor(() => expect(document.title).toBe("Trip plan"));
}

it("installs as the page itself, and gives Rakazo its manifest back on leaving", async () => {
  await open("/page/p1?space=s1");
  const manifest = document.head.querySelector('link[rel="manifest"]');
  expect(manifest?.getAttribute("href")).toBe("/api/v1/pages/p1/app.webmanifest?space=s1");
  expect(manifest?.getAttribute("crossorigin")).toBe("use-credentials");
  expect(document.head.querySelector('link[rel="apple-touch-icon"]')?.getAttribute("href")).toBe(
    "/api/v1/pages/p1/app-icon/180.png?space=s1",
  );
  expect(document.title).toBe("Trip plan");
  expect(container.querySelector("h1")?.textContent).toBe("Trip plan");

  act(() => root.unmount());
  expect(manifest?.getAttribute("href")).toBe("/site.webmanifest");
  expect(manifest?.hasAttribute("crossorigin")).toBe(false);
  expect(document.title).toBe("Rakazo");
});

it("offers Install once the browser can install the page", async () => {
  await open("/page/p1");
  expect(container.querySelector("button")).toBeNull();
  const prompt = vi.fn(async () => undefined);
  await act(async () => {
    window.dispatchEvent(Object.assign(new Event("beforeinstallprompt"), { prompt }));
  });
  const install = container.querySelector("button");
  expect(install?.textContent).toBe("Install");
  await act(async () => install?.click());
  expect(prompt).toHaveBeenCalledOnce();
  expect(container.querySelector("button")).toBeNull();
  act(() => root.unmount());
});

it("says the page is gone when a refresh finds it deleted", async () => {
  await open("/page/p1");
  read.fails = true;
  await act(async () => {
    await client.refetchQueries();
  });
  await vi.waitFor(() =>
    expect(container.querySelector('[role="alert"] h2')?.textContent).toBe(
      "This page isn't available",
    ),
  );
  act(() => root.unmount());
});
