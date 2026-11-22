// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

// The test alias for the macro package has no Trans, so it renders its children as the web build does.
vi.mock("@lingui/react/macro", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@lingui/react/macro")>()),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

const runs = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../../lib/query/rpc", () => ({
  rpc: { runs },
  rpcForSpace: () => ({ runs }),
  createSpaceRpc: () => ({ runs }),
  selectedSpaceId: () => null,
}));

import { emptyActivityFilters } from "../../lib/activity-list-filters";
import { ActivityList } from "./ActivityList";

beforeAll(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  notifyManager.setNotifyFunction((notify) => act(notify));
  i18n.load("en", {});
  i18n.activate("en");
});
afterAll(() => {
  notifyManager.setNotifyFunction((notify) => notify());
  vi.unstubAllGlobals();
});

it("limits each date input by the other so From cannot pass To", async () => {
  runs.list.mockResolvedValue({ runs: [] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  const root = createRoot(container);
  const show = (from: string, to: string) =>
    act(async () =>
      root.render(
        <I18nProvider i18n={i18n}>
          <QueryClientProvider client={client}>
            <ActivityList
              bots={[]}
              groups={[]}
              toggledSections={new Set<string>()}
              onToggleSection={() => undefined}
              onOpenRun={() => undefined}
              onOpenBot={() => undefined}
              onOpenGroup={() => undefined}
              filters={{ ...emptyActivityFilters(), dateRange: { from, to } }}
              onFiltersChange={() => undefined}
              filtersExpanded
              filtersId="filters"
            />
          </QueryClientProvider>
        </I18nProvider>,
      ),
    );
  const input = (id: string) => container.querySelector(`[data-testid="${id}"]`);
  try {
    await show("2026-09-10", "2026-09-20");
    expect(input("activity-date-from")?.getAttribute("max")).toBe("2026-09-20");
    expect(input("activity-date-to")?.getAttribute("min")).toBe("2026-09-10");
    await show("", "");
    expect(input("activity-date-from")?.hasAttribute("max")).toBe(false);
    expect(input("activity-date-to")?.hasAttribute("min")).toBe(false);
  } finally {
    await act(async () => root.unmount());
    client.clear();
  }
});
