// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const health = vi.hoisted(() => vi.fn());
const setAlerts = vi.hoisted(() => vi.fn());
vi.mock("../lib/rpc", () => ({
  rpc: { routines: { health, setAlerts } },
  rpcForSpace: () => ({ routines: { health, setAlerts } }),
  createSpaceRpc: () => ({ routines: { health, setAlerts } }),
  selectedSpaceId: () => null,
}));
vi.mock("./ActivityList", () => ({
  statusLabel: (status: string) => (status === "failed" ? "Failed" : status),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ i18n: { locale: "en" }, t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import { RoutineHealth } from "./RoutineHealth";

it("shows the schedule, attempt and successful execution without claiming delivery", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  health.mockResolvedValue({
    nextRunAt: "2026-11-01T06:00:00Z",
    delayed: true,
    lastAttempt: { at: "2026-11-01T05:00:00Z", status: "failed" },
    lastSuccessAt: "2026-10-31T05:01:00Z",
    delayAlertsEnabled: false,
    failureAlertsEnabled: true,
    delayAlertResult: null,
  });
  setAlerts.mockResolvedValue({ ok: true });
  const container = document.createElement("div");
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <RoutineHealth routineId="routine-1" />
        </QueryClientProvider>,
      ),
    );
    await act(async () =>
      vi.waitFor(() => expect(container.textContent).toContain("Schedule delayed")),
    );
    expect(container.textContent).toContain("Last attempt");
    expect(container.textContent).toContain("Failed");
    expect(container.textContent).toContain("Last successful run");
    expect(container.textContent).not.toContain("Delivered");
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Delay alerts"]')!.click(),
    );
    expect(setAlerts).toHaveBeenCalledWith({ routineId: "routine-1", delayed: true });
  } finally {
    await act(async () => root.unmount());
    client.clear();
    vi.unstubAllGlobals();
  }
});
