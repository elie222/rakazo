// @vitest-environment jsdom

import type { Artifact } from "@rakazo/contracts";
import { flush } from "@rakazo/core/test-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../../../lib/query/rpc", () => {
  const rpc = {
    artifacts: { listSpace: vi.fn(async () => ({ items: [], nextCursor: null })) },
  };
  return {
    rpc,
    rpcForSpace: () => rpc,
    createSpaceRpc: () => rpc,
    selectedSpaceId: () => null,
  };
});
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("../../../components/pages/PagesList", () => ({ PagesList: () => null }));

import { rpc } from "../../../lib/query/rpc";
import { BotLibrary } from "./bot-library";

type LibraryItem = Artifact & { versionCount: number };

function file(name: string, index: number, mimeType = "application/pdf"): LibraryItem {
  return {
    id: `artifact-${index}`,
    botId: "bot-1",
    groupId: null,
    runId: null,
    name,
    description: null,
    mimeType,
    size: 2048,
    version: 1,
    versionCount: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
  };
}

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{location.pathname + location.search}</span>;
}

async function render(items: LibraryItem[] = [], nextCursor: string | null = null) {
  vi.mocked(rpc.artifacts.listSpace).mockResolvedValueOnce({ items, nextCursor });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/app/chat-1"]}>
          <BotLibrary botId="bot-1" botName="Ada" onOpenAllPages={() => undefined} />
          <LocationProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await act(flush);
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(rpc.artifacts.listSpace).mockReset();
  vi.mocked(rpc.artifacts.listSpace).mockResolvedValue({ items: [], nextCursor: null });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  container.remove();
  vi.unstubAllGlobals();
});

it("lists the bot's recent files with their size", async () => {
  await render([file("Report.pdf", 1), file("photo.png", 2, "image/png")]);
  const rows = [
    ...container.querySelectorAll<HTMLAnchorElement>('[data-testid="bot-library-files"] a'),
  ];
  expect(rows.map((row) => row.textContent)).toEqual(["Report.pdf2 KB", "photo.png2 KB"]);
});

it("says where files will show when the bot has none", async () => {
  await render();
  expect(container.textContent).toContain("Files Ada makes and receives show here.");
  expect(container.querySelector('[data-testid="bot-library-files"]')).toBeNull();
});

it("opens a file on the Artifacts page", async () => {
  await render([file("Report.pdf", 1)]);
  await act(async () => {
    container.querySelector<HTMLAnchorElement>('[data-testid="bot-library-files"] a')!.click();
  });
  expect(container.querySelector('[data-testid="location"]')?.textContent).toBe(
    "/app/artifacts/artifact-1?bot=bot-1",
  );
});

it("links the heading to all files when more remain", async () => {
  await render([file("Report.pdf", 1)], "cursor-next");
  const heading = [...container.querySelectorAll("a")].find(
    (entry) => entry.textContent === "Files",
  );
  if (!heading) throw new Error("Missing Files heading link");
  await act(async () => heading.click());
  expect(container.querySelector('[data-testid="location"]')?.textContent).toBe(
    "/app/artifacts?bot=bot-1",
  );
});

it("keeps the heading plain when these are all the files", async () => {
  await render([file("Report.pdf", 1)]);
  const headings = [...container.querySelectorAll("h3")].map((node) => node.textContent);
  expect(headings).toContain("Files");
  expect(
    [...container.querySelectorAll("button")].some((button) => button.textContent === "Files"),
  ).toBe(false);
});

it("shows the load error in place", async () => {
  vi.mocked(rpc.artifacts.listSpace).mockReset().mockRejectedValueOnce(new Error("offline"));
  await render();
  await act(flush);
  expect(container.textContent).toContain("offline");
});
