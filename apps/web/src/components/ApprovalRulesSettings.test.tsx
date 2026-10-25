// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";

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

beforeEach(() => vi.resetAllMocks());

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ApprovalRulesSettings scope="account" />
      </QueryClientProvider>,
    );
  });
  return { container, root, client };
}

it("turns an ask-before preset on and off as a switch", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const rule = {
    id: "rule-1",
    effect: "require_approval",
    matchKind: "category",
    matchValue: "email",
  };
  rpcMock.approvalRules.list.mockResolvedValue([]);
  rpcMock.autoReview.get.mockResolvedValue(settings);
  rpcMock.approvalRules.set.mockResolvedValue(rule);
  rpcMock.approvalRules.remove.mockResolvedValue(undefined);
  const { container, root } = await render();
  const toggle = () =>
    container.querySelector<HTMLButtonElement>('[data-testid="ask-before-email-toggle"]');
  try {
    await vi.waitFor(() => expect(toggle()?.disabled).toBe(false));
    expect(toggle()?.getAttribute("aria-checked")).toBe("false");

    await act(async () => toggle()?.click());
    await vi.waitFor(() => expect(toggle()?.getAttribute("aria-checked")).toBe("true"));
    expect(rpcMock.approvalRules.set).toHaveBeenCalledWith({
      scope: "account",
      effect: "require_approval",
      matchKind: "category",
      matchValue: "email",
    });
    // The preset is the switch, not a second row in the rule list.
    expect(container.textContent).not.toContain("Remove");

    await act(async () => toggle()?.click());
    await vi.waitFor(() => expect(toggle()?.getAttribute("aria-checked")).toBe("false"));
    expect(rpcMock.approvalRules.remove).toHaveBeenCalledWith({ scope: "account", id: "rule-1" });
    await act(async () => root.unmount());
  } finally {
    container.remove();
    vi.unstubAllGlobals();
  }
});

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
          <ApprovalRulesSettings scope="account" />
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
    // Cached, so the toggle works while the refresh is out.
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

it("reads and writes a Space's own confirmations apart from the account's", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const rule = {
    id: "rule-1",
    // Not a preset, so it lists as its own removable rule.
    effect: "always_allow",
    matchKind: "tool",
    matchValue: "send_email",
  };
  rpcMock.approvalRules.list
    .mockReset()
    .mockImplementation(async ({ scope }: { scope: string }) => (scope === "space" ? [rule] : []));
  rpcMock.approvalRules.remove.mockReset().mockResolvedValue({ ok: true });
  rpcMock.autoReview.get.mockReset().mockResolvedValue(settings);
  rpcMock.autoReview.set.mockReset().mockResolvedValue({ ...settings, enabled: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (scope: "account" | "space") =>
    act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ApprovalRulesSettings scope={scope} />
        </QueryClientProvider>,
      );
    });
  const remove = () =>
    [...container.querySelectorAll("button")].find((button) => button.textContent === "Remove");
  try {
    await render("space");
    await vi.waitFor(() => expect(remove()).toBeDefined());
    expect(rpcMock.autoReview.get).toHaveBeenCalledWith({ scope: "space" }, expect.anything());
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="auto-review-toggle"]')?.click(),
    );
    expect(rpcMock.autoReview.set).toHaveBeenLastCalledWith({ enabled: true, scope: "space" });
    await act(async () => remove()?.click());
    expect(rpcMock.approvalRules.remove).toHaveBeenLastCalledWith({
      scope: "space",
      id: "rule-1",
    });

    await render("account");
    await vi.waitFor(() =>
      expect(rpcMock.approvalRules.list).toHaveBeenCalledWith(
        { scope: "account" },
        expect.anything(),
      ),
    );
    await vi.waitFor(() => expect(container.querySelector('[role="status"]')).toBeNull());
    expect(remove()).toBeUndefined();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
