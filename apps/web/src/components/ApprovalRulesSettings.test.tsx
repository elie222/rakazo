// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const rpcMock = vi.hoisted(() => ({
  approvalRules: { list: vi.fn(), set: vi.fn(), remove: vi.fn() },
  autoReview: { get: vi.fn(), set: vi.fn() },
}));
vi.mock("../lib/rpc", () => ({
  rpc: rpcMock,
  rpcForSpace: () => rpcMock,
  createSpaceRpc: () => rpcMock,
  selectedSpaceId: () => null,
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray) => parts.join("");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
  Label: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Spinner: (props: ComponentProps<"svg">) => <svg role="status" {...props} />,
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: Omit<ComponentProps<"button">, "onChange"> & {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
  }) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
      {...props}
    />
  ),
}));

import { ApprovalRulesSettings } from "./ApprovalRulesSettings";

const settings = { enabled: false, skipApprovals: false, checkerAvailable: true };

it("keeps a saved toggle when the revisit's older background read lands after it", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  rpcMock.approvalRules.list.mockResolvedValue([]);
  rpcMock.autoReview.get.mockResolvedValueOnce(settings);
  rpcMock.autoReview.set.mockResolvedValue({ ...settings, skipApprovals: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const mount = async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ApprovalRulesSettings />
        </QueryClientProvider>,
      );
    });
    return root;
  };
  const toggle = () =>
    container.querySelector<HTMLButtonElement>('[data-testid="skip-approvals-toggle"]');
  try {
    const first = await mount();
    await vi.waitFor(() => expect(toggle()?.disabled).toBe(false));
    await act(async () => first.unmount());

    let resolveRead: (value: typeof settings) => void = () => undefined;
    rpcMock.autoReview.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    const second = await mount();
    // Cached, so no spinner and the toggle works while the refresh is out.
    expect(container.querySelector('[aria-label="Loading rules…"]')).toBeNull();
    expect(rpcMock.autoReview.get).toHaveBeenCalledTimes(2);
    await act(async () => toggle()?.click());
    await vi.waitFor(() => expect(toggle()?.getAttribute("aria-checked")).toBe("true"));
    await act(async () => resolveRead(settings));
    // Query updates reach components on a timer; let any late write land.
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(toggle()?.getAttribute("aria-checked")).toBe("true");
    await act(async () => second.unmount());
  } finally {
    container.remove();
    vi.unstubAllGlobals();
  }
});
