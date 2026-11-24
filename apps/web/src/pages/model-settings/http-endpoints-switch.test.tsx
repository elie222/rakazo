// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HttpEndpointsSwitch } from "./http-endpoints-switch";

const api = vi.hoisted(() => ({
  me: vi.fn(),
  allowed: vi.fn(),
  run: vi.fn(),
}));

vi.mock("../../lib/query/rpc", () => ({
  rpc: {
    me: api.me,
    models: { httpEndpointsAllowed: api.allowed },
  },
}));
vi.mock("../../lib/query/query", () => ({
  useSpaceQueries: () => ({
    me: { queryKey: () => ["me"] },
    models: {
      httpEndpointsAllowed: { queryKey: () => ["http-endpoints"], key: () => ["http-endpoints"] },
    },
  }),
  useSave: () => ({ pending: false, error: null, run: api.run }),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: parts }, ...values),
  }),
  Trans: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Label: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: ComponentProps<"button"> & {
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
  }) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked === true}
      onClick={() => onCheckedChange?.(checked !== true)}
      {...props}
    />
  ),
}));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

async function renderSwitch(admin: boolean) {
  api.me.mockResolvedValue({ isAdmin: admin });
  api.allowed.mockResolvedValue({ allowed: false });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <HttpEndpointsSwitch />
      </QueryClientProvider>,
    );
  });
  return container;
}

it("shows the switch only to admins", async () => {
  const admin = await renderSwitch(true);
  const toggle = await vi.waitFor(() => {
    const found = admin.querySelector('[data-testid="http-endpoints-toggle"]');
    if (!found) throw new Error("the switch is not rendered yet");
    return found;
  });
  expect(toggle.getAttribute("aria-checked")).toBe("false");

  const member = await renderSwitch(false);
  expect(member.querySelector('[data-testid="http-endpoints-switch"]')).toBeNull();
});

it("saves the toggle as the admin flips it", async () => {
  const container = await renderSwitch(true);
  const toggle = await vi.waitFor(() => {
    const found = container.querySelector<HTMLElement>('[data-testid="http-endpoints-toggle"]');
    if (!found) throw new Error("the switch is not rendered yet");
    return found;
  });
  await act(async () => {
    toggle.click();
  });
  expect(api.run).toHaveBeenCalledWith(true);
});
