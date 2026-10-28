// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const runs = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../lib/rpc", () => ({
  rpc: { runs },
  rpcForSpace: () => ({ runs }),
  createSpaceRpc: () => ({ runs }),
  selectedSpaceId: () => null,
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray) => parts.join("");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/ui-web", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: (props: ComponentProps<"button">) => <button type="button" {...props} />,
    Collapsible: Container,
    CollapsibleContent: Container,
    Input: () => null,
    Label: Container,
    NativeSelect: () => null,
    NativeSelectOption: () => null,
    Spinner: (props: ComponentProps<"svg">) => <svg role="status" {...props} />,
  };
});

import { emptyActivityFilters } from "../lib/activity-list-filters";
import { ActivityList } from "./ActivityList";

const run = {
  runId: "run-1",
  botId: "bot-1",
  botName: "Scout",
  status: "completed",
  updatedAt: new Date().toISOString(),
};

it("reopens with cached runs and refreshes them in the background", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  runs.list.mockImplementation(async ({ filter }: { filter: string }) => ({
    runs: filter === "recent" ? [run] : [],
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const mount = async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ActivityList
            onOpenRun={() => undefined}
            filters={emptyActivityFilters()}
            onFiltersChange={() => undefined}
            filtersExpanded={false}
            filtersId="filters"
          />
        </QueryClientProvider>,
      );
    });
    return root;
  };
  try {
    const first = await mount();
    await vi.waitFor(() => expect(container.textContent).toContain("Scout"));
    await act(async () => first.unmount());
    await client.invalidateQueries();
    runs.list.mockClear();

    const second = await mount();
    expect(container.querySelector('[aria-label="Loading activity…"]')).toBeNull();
    expect(container.textContent).toContain("Scout");
    await vi.waitFor(() => expect(runs.list).toHaveBeenCalledTimes(2));
    await act(async () => second.unmount());
  } finally {
    container.remove();
    vi.unstubAllGlobals();
  }
});
