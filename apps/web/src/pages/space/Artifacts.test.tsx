// @vitest-environment jsdom

import { deferred, flush } from "@rakazo/core/test-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  listSpace: vi.fn(),
  remove: vi.fn(),
  listVersions: vi.fn(),
  getById: vi.fn(),
  copy: vi.fn(),
}));
vi.mock("../../lib/copy-text", () => ({ useCopyText: () => [false, api.copy] }));
const rpcClient = vi.hoisted(() => ({ artifacts: api, bootstrap: vi.fn() }));
const uiLocale = vi.hoisted(() => ({ current: "en" }));
vi.mock("../../lib/query/rpc", () => ({
  rpc: rpcClient,
  rpcForSpace: () => rpcClient,
  createSpaceRpc: () => rpcClient,
  selectedSpaceId: () => null,
}));
vi.mock("../../lib/bootstrap", () => ({
  takeInitialBootstrap: vi.fn().mockResolvedValue({ bots: [] }),
}));
vi.mock("../../lib/pages/artifact-open", () => ({
  decodeArtifactBase64: (source: string) => new TextEncoder().encode(atob(source)),
  downloadArtifactBytes: vi.fn(),
}));
vi.mock("../../lib/locale/relative-time", () => ({ formatRelativeTime: () => "just now" }));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + part + (values[index] ?? ""), "");
  return {
    useLingui: () => ({ t, i18n: { locale: uiLocale.current } }),
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});
vi.mock("@rakazo/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@rakazo/ui-web", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    AlertDialog: ({ children }: { children?: ReactNode }) => (
      <div role="alertdialog">{children}</div>
    ),
    AlertDialogAction: ({
      variant: _variant,
      ...props
    }: ComponentProps<"button"> & { variant?: string }) => <button {...props} />,
    AlertDialogCancel: Container,
    AlertDialogContent: Container,
    AlertDialogDescription: Container,
    AlertDialogFooter: Container,
    AlertDialogHeader: Container,
    AlertDialogTitle: Container,
    BotAvatar: () => <span />,
    CopyTextFallback: () => null,
    Spinner: (props: ComponentProps<"svg">) => <svg role="status" {...props} />,
    Button: (props: ComponentProps<"button">) => <button {...props} />,
    buttonVariants: () => "",
    Empty: Container,
    EmptyDescription: Container,
    EmptyHeader: Container,
    EmptyMedia: Container,
    EmptyTitle: Container,
    ListSearchInput: ({
      query,
      setQuery,
      label,
    }: {
      query: string;
      setQuery: (query: string) => void;
      label: string;
    }) => (
      <input aria-label={label} value={query} onChange={(event) => setQuery(event.target.value)} />
    ),
    OptionSelect: ({
      options,
      value,
      onValueChange,
      "aria-label": label,
    }: {
      options: { value: string; label: string }[];
      value: string;
      onValueChange: (value: string) => void;
      "aria-label": string;
    }) => (
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    ),
    Select: Container,
    SelectContent: Container,
    SelectGroup: Container,
    SelectItem: Container,
    SelectTrigger: Container,
    SelectValue: () => null,
    ToggleGroup: Container,
    ToggleGroupItem: Container,
    Tooltip: Container,
    TooltipContent: () => null,
    TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  };
});

import { ArtifactsPage } from "./Artifacts";

function artifact(name: string, id: string, createdAt = new Date().toISOString()) {
  return {
    id,
    botId: null,
    groupId: null,
    runId: null,
    name,
    description: null,
    mimeType: "text/markdown",
    size: 128,
    version: 1,
    createdAt,
    versionCount: 1,
  };
}

function typeSearch(container: HTMLElement, value: string) {
  const input = container.querySelector("input[aria-label='Search artifacts']");
  if (!(input instanceof HTMLInputElement)) throw new Error("missing search input");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

let queryClient: QueryClient;
beforeEach(() => {
  uiLocale.current = "en";
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

async function renderArtifacts(entry = "/app/artifacts") {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const rerender = () =>
    act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[entry]}>
            <Routes>
              <Route path="/app/artifacts/:artifactId?" element={<ArtifactsPage />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      ),
    );
  await rerender();
  // Let query results reach the screen.
  if (vi.isFakeTimers()) {
    await act(async () => vi.advanceTimersByTimeAsync(0));
  } else {
    await act(flush);
  }
  return {
    container,
    rerender,
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

it("opens the Artifacts screen and lists what listSpace returns", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.listSpace.mockResolvedValue({
    items: [artifact("Q3 Content Calendar", "artifact-1")],
    nextCursor: null,
  });
  const page = await renderArtifacts();
  try {
    expect(page.container.textContent).toContain("Artifacts");
    expect(page.container.textContent).toContain("Q3 Content Calendar");
    expect(page.container.querySelector("a[href='/app']")?.getAttribute("aria-label")).toBe("Back");
    expect(page.container.querySelector("[data-testid='app-rail']")).toBeNull();
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("keeps loading later pages when search hides the current snapshot", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.listSpace.mockImplementation(async (input: { cursor?: string }) => {
    if (!input.cursor) {
      return { items: [artifact("Alpha notes", "artifact-1")], nextCursor: "artifact-1" };
    }
    return { items: [artifact("Beta report", "artifact-2")], nextCursor: null };
  });
  const page = await renderArtifacts();
  try {
    expect(page.container.textContent).toContain("Alpha notes");
    const search = page.container.querySelector<HTMLButtonElement>('button[aria-label="Search"]');
    expect(search).toBeTruthy();
    await act(async () => {
      search?.click();
    });
    await act(async () => {
      typeSearch(page.container, "Beta");
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(page.container.textContent).toContain("Beta report");
      });
    });
    expect(page.container.textContent).not.toContain("Alpha notes");
    expect(api.listSpace).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: "artifact-1" }),
      expect.anything(),
    );
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("still offers Load more when filters match nothing on the loaded page", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let releaseSecondPage: (() => void) | undefined;
  const secondPage = new Promise<{
    items: ReturnType<typeof artifact>[];
    nextCursor: string | null;
  }>((resolve) => {
    releaseSecondPage = () =>
      resolve({ items: [artifact("Beta report", "artifact-2")], nextCursor: null });
  });
  api.listSpace.mockImplementation(async (input: { cursor?: string }) => {
    if (!input.cursor) {
      return { items: [artifact("Alpha notes", "artifact-1")], nextCursor: "artifact-1" };
    }
    return secondPage;
  });
  const page = await renderArtifacts();
  try {
    await act(async () => {
      page.container.querySelector<HTMLButtonElement>('button[aria-label="Search"]')?.click();
    });
    await act(async () => {
      typeSearch(page.container, "Beta");
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(page.container.querySelector('button[aria-label="Load more"]')).not.toBeNull();
      });
    });
    expect(page.container.textContent).not.toContain("Beta report");
    await act(async () => {
      releaseSecondPage?.();
      await secondPage;
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(page.container.textContent).toContain("Beta report");
      });
    });
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("reopens with cached artifacts and refreshes them in the background", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.listSpace.mockReset().mockResolvedValue({
    items: [artifact("Cached notes", "artifact-1")],
    nextCursor: null,
  });
  const first = await renderArtifacts();
  expect(first.container.textContent).toContain("Cached notes");
  await first.cleanup();
  await queryClient.invalidateQueries();

  const finish = deferred<{ items: ReturnType<typeof artifact>[]; nextCursor: null }>();
  api.listSpace.mockImplementationOnce(() => finish.promise);
  const page = await renderArtifacts();
  try {
    // Painted from the cache while the refresh is still out, with no spinner.
    expect(page.container.textContent).toContain("Cached notes");
    expect(page.container.querySelector('[aria-label="Loading…"]')).toBeNull();
    await act(async () =>
      finish.resolve({ items: [artifact("Fresh report", "artifact-2")], nextCursor: null }),
    );
    await act(async () => {
      await vi.waitFor(() => expect(page.container.textContent).toContain("Fresh report"));
    });
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it.each([
  { locale: "fr", legacy: false },
  { locale: "de", legacy: false },
  { locale: "fr", legacy: true },
])(
  "starts This week on Monday in $locale (without Intl week info: $legacy)",
  async ({ locale, legacy }) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    if (legacy) {
      const browserIntl = Object.create(Intl);
      Object.defineProperty(browserIntl, "Locale", {
        value: class {
          constructor(readonly baseName: string) {}
        },
      });
      vi.stubGlobal("Intl", browserIntl);
    }
    vi.useFakeTimers();
    const sunday = new Date(2026, 10, 15, 23, 59, 59);
    vi.setSystemTime(sunday);
    api.listSpace.mockReset().mockResolvedValue({
      items: [
        artifact("Monday report", "monday", new Date(2026, 10, 9, 0, 0, 0).toISOString()),
        artifact("Sunday report", "sunday", sunday.toISOString()),
      ],
      nextCursor: null,
    });
    const page = await renderArtifacts();
    try {
      const select = page.container.querySelector<HTMLSelectElement>(
        'select[aria-label="Filter by date"]',
      )!;
      await act(async () => {
        select.value = "week";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      // English and Hebrew keep their Sunday week start; French and German include last Monday.
      expect(page.container.textContent).toContain("Sunday report");
      expect(page.container.textContent).not.toContain("Monday report");
      uiLocale.current = locale;
      await page.rerender();
      expect(page.container.textContent).toContain("Monday report");
      uiLocale.current = "he";
      await page.rerender();
      expect(page.container.textContent).not.toContain("Monday report");
      expect(page.container.textContent).toContain("Sunday report");
      uiLocale.current = locale;
      await page.rerender();
      expect(page.container.textContent).toContain("Monday report");

      await act(async () => vi.advanceTimersByTimeAsync(1000));
      expect(page.container.textContent).not.toContain("Monday report");
      expect(page.container.textContent).not.toContain("Sunday report");
    } finally {
      await page.cleanup();
      queryClient.clear();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  },
);

it.each([
  ["today", new Date(2026, 10, 12, 23, 59, 59)],
  ["week", new Date(2026, 10, 14, 23, 59, 59)],
  ["month", new Date(2026, 10, 30, 23, 59, 59)],
])("refreshes the %s filter at the local calendar boundary", async (filter, before) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.setSystemTime(before);
  api.listSpace.mockResolvedValue({
    items: [artifact("Previous period file", "old", before.toISOString())],
    nextCursor: null,
  });
  const page = await renderArtifacts();
  try {
    const select = page.container.querySelector<HTMLSelectElement>(
      'select[aria-label="Filter by date"]',
    );
    expect(select).not.toBeNull();
    await act(async () => {
      if (select) select.value = filter;
      select?.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(page.container.textContent).toContain("Previous period file");
    await act(async () => vi.advanceTimersByTimeAsync(999));
    expect(page.container.textContent).toContain("Previous period file");
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(page.container.textContent).not.toContain("Previous period file");
    await act(async () => {
      if (select) select.value = "all";
      select?.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(page.container.textContent).toContain("Previous period file");
  } finally {
    await page.cleanup();
    queryClient.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

async function askToDelete(page: { container: HTMLElement }) {
  await act(async () =>
    page.container.querySelector<HTMLButtonElement>('button[aria-label^="Delete"]')!.click(),
  );
  const dialog = () => page.container.querySelector('[role="alertdialog"]');
  return { dialog, confirm: () => dialog()?.querySelector("button") };
}

it("deletes an artifact once, holds the confirmation meanwhile, then reads the list again", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.listSpace.mockReset().mockResolvedValue({
    items: [artifact("notes.md", "artifact-1"), artifact("plan.md", "artifact-2")],
    nextCursor: null,
  });
  const removing = deferred<void>();
  api.remove.mockReset().mockReturnValue(removing.promise);
  const page = await renderArtifacts();
  try {
    const { dialog, confirm } = await askToDelete(page);
    await act(async () => {
      confirm()!.click();
      confirm()!.click();
    });
    expect(api.remove.mock.calls).toEqual([[{ artifactId: "artifact-1" }]]);
    expect(confirm()?.disabled).toBe(true);
    expect(confirm()?.textContent).toBe("Deleting…");

    api.listSpace.mockResolvedValue({
      items: [artifact("plan.md", "artifact-2")],
      nextCursor: null,
    });
    await act(async () => removing.resolve());
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(api.listSpace).toHaveBeenCalledTimes(2);
    expect(page.container.textContent).not.toContain("notes.md");
    expect(page.container.textContent).toContain("plan.md");
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("drops a deleted artifact from the list even when the list cannot be read again", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.listSpace.mockReset().mockResolvedValue({
    items: [artifact("notes.md", "artifact-1"), artifact("plan.md", "artifact-2")],
    nextCursor: null,
  });
  api.remove.mockReset().mockResolvedValue(undefined);
  const page = await renderArtifacts();
  try {
    const { dialog, confirm } = await askToDelete(page);
    api.listSpace.mockRejectedValue(new TypeError("Failed to fetch"));
    await act(async () => confirm()!.click());
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(page.container.textContent).not.toContain("notes.md");
    expect(page.container.textContent).toContain("plan.md");
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("says why an artifact was not deleted and offers the confirmation again", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.listSpace.mockReset().mockResolvedValue({
    items: [artifact("notes.md", "artifact-1")],
    nextCursor: null,
  });
  api.remove.mockReset().mockRejectedValue({ code: "INTERNAL_SERVER_ERROR" });
  const page = await renderArtifacts();
  try {
    const { dialog, confirm } = await askToDelete(page);
    await act(async () => confirm()!.click());
    await vi.waitFor(() =>
      expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe(
        "Could not delete this artifact.",
      ),
    );
    expect(confirm()?.disabled).toBe(false);
    expect(page.container.textContent).toContain("notes.md");
    expect(api.listSpace).toHaveBeenCalledTimes(1);
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it.each(["text/markdown", "text/plain"])(
  "copies raw %s in the preview pane and scopes select-all",
  async (mimeType) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const source = "# Raw source\n\n**Keep** the markup";
    const file = { ...artifact("notes.md", "artifact-1"), mimeType, contentBase64: btoa(source) };
    api.listSpace.mockResolvedValue({ items: [file], nextCursor: null });
    api.listVersions.mockResolvedValue([file]);
    api.getById.mockResolvedValue(file);
    api.copy.mockReset();
    const page = await renderArtifacts("/app/artifacts/artifact-1");
    try {
      await act(async () =>
        vi.waitFor(() =>
          expect(page.container.querySelector("[data-file-preview-body]")).not.toBeNull(),
        ),
      );
      const copy = page.container.querySelector<HTMLButtonElement>(
        'button[aria-label="Copy notes.md"]',
      );
      expect(copy).not.toBeNull();
      await act(async () => copy!.click());
      expect(api.copy).toHaveBeenCalledExactlyOnceWith(source);
      const body = page.container.querySelector<HTMLElement>("[data-file-preview-body]")!;
      body.focus();
      expect(document.activeElement).toBe(body);
      const event = new KeyboardEvent("keydown", {
        key: "a",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      await act(async () => body.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(true);
      expect(window.getSelection()?.toString()).toBe(source);
    } finally {
      await page.cleanup();
      vi.unstubAllGlobals();
    }
  },
);
