// @vitest-environment jsdom
import type { ModelQuota } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const quotaRead = vi.hoisted(() => vi.fn());

vi.mock("../../lib/query", () => ({
  useSpaceQueries: () => ({
    models: {
      quota: {
        queryKey: () => ["quota"],
        queryOptions: () => ({ queryKey: ["quota"], queryFn: quotaRead }),
      },
    },
  }),
}));
vi.mock("../../lib/space-rpc", () => ({ useSpaceRpc: () => ({ models: { quota: quotaRead } }) }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
    i18n: { locale: "de" },
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
}));

import { ConnectionQuota } from "./connection-quota";

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

async function render(quota: Partial<ModelQuota>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  quotaRead.mockResolvedValue({
    credentialId: "connection",
    observedAt: null,
    checkedAt: "2030-01-01T00:00:00.000Z",
    windows: [],
    ...quota,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ConnectionQuota credentialId="connection" label="Work" />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await vi.waitFor(() => expect(quotaRead).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  const text = host.textContent ?? "";
  await act(async () => root.unmount());
  return text;
}

it("shows only the name of a connection with no quota to read", async () => {
  const text = await render({ status: "unsupported" });
  expect(text).toContain("Work");
  expect(text).not.toContain("Quota unavailable");
  expect(text).not.toContain("Refresh");
});

it("offers Refresh when a reading failed", async () => {
  const text = await render({ status: "unavailable" });
  expect(text).toContain("Quota unavailable");
  expect(text).toContain("Refresh");
});

it("formats the remaining percentage in the app language", async () => {
  const text = await render({
    status: "fresh",
    observedAt: "2030-01-01T00:00:00.000Z",
    windows: [{ id: "seven_day", usedPercent: 54.5, resetsAt: null, modelIds: null }],
  });
  expect(text).toContain("45,5% remaining");
});
