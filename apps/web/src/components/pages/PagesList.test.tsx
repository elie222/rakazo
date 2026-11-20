// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PagesList } from "./PagesList";

const rename = vi.hoisted(() => vi.fn());
const pageItems = vi.hoisted(() => ({
  current: [] as { id: string; title: string; updatedAt: string }[],
}));
const page = (index: number) => ({
  id: `page-${index}`,
  title: `Plan ${index}`,
  updatedAt: new Date().toISOString(),
});
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: String.raw }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../lib/query/query", () => ({
  useSpaceQueries: () => ({ pages: { list: { infiniteOptions: () => ({}) } } }),
}));
vi.mock("../../lib/pages/pages", () => ({ useOpenPage: () => vi.fn() }));
vi.mock("../../lib/pages/page-actions", () => ({
  pageMutationOptions: () => ({ pin: {}, remove: {}, rename: {} }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({}),
  useMutation: () => ({ mutate: rename, reset: vi.fn() }),
  useInfiniteQuery: () => ({ data: { pages: [{ items: pageItems.current }] } }),
}));
vi.mock("@rakazo/ui-web", async (importActual) => ({
  ...(await importActual<object>()),
  DropdownMenu: ({ children }: { children: ReactNode }) => children,
  DropdownMenuTrigger: () => null,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => children,
  DropdownMenuItem: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));
beforeEach(() => {
  pageItems.current = [{ id: "page-1", title: "Plan", updatedAt: new Date().toISOString() }];
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
it.each([
  { key: "Enter", isComposing: true },
  { key: "Escape", isComposing: true },
  { key: "Enter", keyCode: 229 },
  { key: "Escape", keyCode: 229 },
])("keeps list renaming open during IME composition (%o)", async (keyboard) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  try {
    await act(async () => root.render(<PagesList botId="bot-1" />));
    await act(async () => {
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent === "Rename")!
        .click();
    });
    const input = document.querySelector<HTMLInputElement>('[aria-label="Page title"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "计划",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const onWindowKey = vi.fn();
    window.addEventListener("keydown", onWindowKey);
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...keyboard }));
    });
    window.removeEventListener("keydown", onWindowKey);
    expect(document.querySelector('[aria-label="Page title"]')).toBe(input);
    expect(input.value).toBe("计划");
    expect(rename).not.toHaveBeenCalled();
    if (keyboard.key === "Escape") expect(onWindowKey).not.toHaveBeenCalled();
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: keyboard.key }));
    });
    expect(document.querySelector('[aria-label="Page title"]')).toBeNull();
    if (keyboard.key === "Enter")
      expect(rename).toHaveBeenCalledWith({ pageId: "page-1", title: "计划" });
    else expect(rename).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});

async function renderPreview(onOpenAll = vi.fn()) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(<PagesList botId="bot-1" preview={{ onOpenAll }} />));
  return { host, root, onOpenAll };
}

it("previews nothing at all while the bot has no pages", async () => {
  pageItems.current = [];
  const { host, root } = await renderPreview();
  expect(host.childElementCount).toBe(0);
  await act(async () => root.unmount());
});

it("previews the latest three pages and links the heading to the whole list", async () => {
  pageItems.current = [1, 2, 3, 4].map(page);
  const { host, root, onOpenAll } = await renderPreview();
  expect(host.querySelectorAll("li")).toHaveLength(3);
  await act(async () => {
    [...host.querySelectorAll("button")].find((button) => button.textContent === "Pages")!.click();
  });
  expect(onOpenAll).toHaveBeenCalledOnce();
  await act(async () => root.unmount());
});

it("keeps a plain heading when the preview shows every page", async () => {
  pageItems.current = [1, 2].map(page);
  const { host, root } = await renderPreview();
  expect(host.querySelectorAll("li")).toHaveLength(2);
  expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Pages")).toBe(false);
  await act(async () => root.unmount());
});
