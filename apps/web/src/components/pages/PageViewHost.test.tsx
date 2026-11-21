// @vitest-environment jsdom

import { flush } from "@rakazo/core/test-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import type * as PagesLib from "../../lib/pages";
import { createPageSession, PagesProvider } from "../../lib/pages";
import { PageNotice } from "./PageNotice";
import { PageViewHost } from "./PageViewHost";

const { replyFlags, state } = vi.hoisted(() => ({
  replyFlags: [] as boolean[],
  state: { mine: undefined as boolean | undefined, failWith: undefined as string | undefined },
}));
vi.mock("../../lib/pages", async (importActual) => {
  const actual = await importActual<typeof PagesLib>();
  return {
    ...actual,
    usePageDocument: (...args: Parameters<typeof actual.usePageDocument>) => {
      replyFlags.push(args[2] as boolean);
      return actual.usePageDocument(...args);
    },
  };
});
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ i18n: { locale: "en" }, t: String.raw }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../lib/query", () => ({
  useSpaceQueries: () => ({
    pages: {
      get: {
        // Like the server: the link only when asked for.
        queryOptions: ({ input }: { input: { pageId: string; link?: true } }) => ({
          queryKey: ["page", input],
          queryFn: async () => {
            if (state.failWith) throw Object.assign(new Error("failed"), { code: state.failWith });
            return {
              id: "p1",
              title: "Plan",
              code: "",
              owner: { name: "" },
              visibility: "link",
              ...(state.mine === undefined ? {} : { mine: state.mine }),
              shareUrl: input.link === true ? "https://rakazo.example/p/1" : null,
            };
          },
        }),
      },
    },
  }),
}));
vi.mock("../../lib/page-actions", () => ({
  pageMutationOptions: () => ({ rename: {}, setVisibility: {} }),
}));
vi.mock("./PageView", () => ({
  PageView: ({
    composer,
    share,
    notice,
  }: {
    composer: ReactNode;
    share: ReactNode;
    notice?: ReactNode;
  }) => (
    <div>
      {notice}
      {share}
      {composer}
    </div>
  ),
}));

afterEach(() => {
  state.mine = undefined;
  state.failWith = undefined;
  replyFlags.length = 0;
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("docks the chat's composer over a tablet's page sheet, so its reply goes to the page", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // A touch tablet: coarse pointer and at least 900px wide.
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal("fetch", async () => new Response(""));
  const session = createPageSession();
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={["/app/bot-1?page=p1"]}>
          <PagesProvider value={{ open: () => {}, session }}>
            <PageViewHost />
          </PagesProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  await act(flush);
  expect(session.dock.get().node).not.toBeNull();
  const card = {
    id: "m1",
    blocks: [{ kind: "page" as const, pageId: "p1", version: 1, title: "Plan" }],
  };
  expect(session.send("mark task 3 done", [card])).toEqual({
    text: "mark task 3 done",
    replyToMessageId: "m1",
  });
  root.unmount();
});

it("shows the link when Share opens on a page that is already shared", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal("fetch", async () => new Response(""));
  const session = createPageSession();
  session.askShare("p1");
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={["/app/bot-1?page=p1"]}>
          <PagesProvider value={{ open: () => {}, session }}>
            <PageViewHost />
          </PagesProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  await act(flush);
  const share = document.querySelector('[data-testid="page-share"]');
  expect(share?.textContent).toContain("Open link");
  expect(share?.querySelector("a")?.getAttribute("href")).toBe("https://rakazo.example/p/1");
  root.unmount();
});

it("announces why a page is not showing", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () =>
    root.render(<PageNotice title="This page couldn't load" detail="Check your connection." />),
  );
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "This page couldn't load",
  );
  root.unmount();
});

it("turns reply buttons off in another member's page, and keeps them in the owner's", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal("fetch", async () => new Response(""));
  const open = async (mine: boolean | undefined) => {
    state.mine = mine;
    replyFlags.length = 0;
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <MemoryRouter initialEntries={["/app/bot-1?page=p1"]}>
            <PagesProvider value={{ open: () => {}, session: createPageSession() }}>
              <PageViewHost />
            </PagesProvider>
          </MemoryRouter>
        </QueryClientProvider>,
      ),
    );
    await act(flush);
    const last = replyFlags.at(-1);
    root.unmount();
    return last;
  };
  expect(await open(false)).toBe(false);
  expect(await open(true)).toBe(true);
  // An older server sends no ownership: the page is the viewer's own, as before.
  expect(await open(undefined)).toBe(true);
});
