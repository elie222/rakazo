// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { SharedPages } from "./shared-pages";

const read = vi.hoisted(() => ({
  hasNextPage: false,
  items: [] as { id: string; title: string; ownerName?: string }[],
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: String.raw }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../lib/query", () => ({
  useSpaceQueries: () => ({ pages: { list: { infiniteOptions: () => ({}) } } }),
}));
const openPage = vi.hoisted(() => vi.fn());
vi.mock("../../lib/pages", () => ({ useOpenPage: () => openPage }));
vi.mock("@tanstack/react-query", () => ({
  useInfiniteQuery: () => ({
    data: { pages: [{ items: read.items }] },
    hasNextPage: read.hasNextPage,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

const closeMobileSidebar = vi.fn();
const shelf = async (showSpaceSearch = false) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () =>
    root.render(
      <SharedPages showSpaceSearch={showSpaceSearch} closeMobileSidebar={closeMobileSidebar} />,
    ),
  );
  return { text: document.body.textContent ?? "", unmount: () => act(async () => root.unmount()) };
};

it("counts what is loaded, and says there are more while another page can be read", async () => {
  read.items = [{ id: "p1", title: "Plan", ownerName: "Ada" }];
  read.hasNextPage = false;
  const all = await shelf();
  expect(all.text).toContain("Shared pages1");
  await all.unmount();
  read.hasNextPage = true;
  const more = await shelf();
  expect(more.text).toContain("Shared pages1+");
  await more.unmount();
});

it("is absent while empty or while the Space search shows", async () => {
  read.items = [];
  read.hasNextPage = false;
  expect((await shelf()).text).toBe("");
  read.items = [{ id: "p1", title: "Plan" }];
  document.body.replaceChildren();
  expect((await shelf(true)).text).toBe("");
});

it("closes the mobile sidebar before it opens a shared page", async () => {
  read.items = [{ id: "p1", title: "Plan" }];
  read.hasNextPage = false;
  const order: string[] = [];
  closeMobileSidebar.mockImplementation(() => order.push("close"));
  openPage.mockImplementation(() => order.push("open"));
  const view = await shelf();
  // The shelf starts folded: open it, then pick the page.
  await act(async () => document.body.querySelector("button")?.click());
  const row = [...document.body.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Plan"),
  );
  await act(async () => row?.click());
  expect(order).toEqual(["close", "open"]);
  await view.unmount();
});
