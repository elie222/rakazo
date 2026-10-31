// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";

const rpcMock = vi.hoisted(() => ({
  approvalRules: { list: vi.fn(), set: vi.fn(), remove: vi.fn(), preview: vi.fn() },
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
vi.mock("@rakazo/ui-web", async () => {
  const { createContext, useContext } = await import("react");
  const Group = createContext<{ value: string[]; onValueChange: (value: string[]) => void }>({
    value: [],
    onValueChange: () => undefined,
  });
  return {
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    Button: ({
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
    ToggleGroup: ({
      value,
      onValueChange,
      children,
      spacing: _spacing,
      ...props
    }: Omit<ComponentProps<"div">, "onChange"> & {
      value: string[];
      onValueChange: (value: string[]) => void;
      spacing?: number;
      disabled?: boolean;
    }) => (
      <Group.Provider value={{ value, onValueChange }}>
        <div {...props}>{children}</div>
      </Group.Provider>
    ),
    ToggleGroupItem: ({ value, children }: { value: string; children?: ReactNode }) => {
      const group = useContext(Group);
      return (
        <button
          type="button"
          aria-pressed={group.value.includes(value)}
          onClick={() => group.onValueChange([value])}
        >
          {children}
        </button>
      );
    },
  };
});

import { ApprovalRulesSettings } from "./ApprovalRulesSettings";

const settings = { mode: "ask", enabled: false, skipApprovals: false, checkerAvailable: true };

beforeEach(() => vi.resetAllMocks());

async function render(scope: "account" | "space" = "account") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ApprovalRulesSettings scope={scope} />
      </QueryClientProvider>,
    );
  });
  return { container, root, client };
}

const button = (container: HTMLElement, name: string, within = "") =>
  [...container.querySelectorAll<HTMLButtonElement>(`${within} button`)].find(
    (candidate) => candidate.textContent === name,
  );

it("clears a preview and ignores old responses when another saved rule changes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  rpcMock.approvalRules.list.mockResolvedValue([
    { id: "tool", effect: "always_allow", matchKind: "tool", matchValue: "gmail_send_email" },
    { id: "connector", effect: "deny", matchKind: "connector", matchValue: "gmail" },
  ]);
  rpcMock.autoReview.get.mockResolvedValue(settings);
  rpcMock.approvalRules.preview.mockResolvedValue({ before: "deny", after: "deny" });
  rpcMock.approvalRules.remove.mockResolvedValue({ ok: true });
  rpcMock.approvalRules.set.mockResolvedValue({
    id: "connector",
    effect: "always_allow",
    matchKind: "connector",
    matchValue: "gmail",
  });
  const { container, root } = await render();
  try {
    await vi.waitFor(() => expect(button(container, "Preview")).toBeDefined());
    await act(async () => button(container, "Preview")!.click());
    await act(async () => button(container, "Test rule")!.click());
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    const connectorRow =
      container.querySelector('[aria-label="Gmail"]')!.parentElement!.parentElement!;
    await act(async () =>
      [...connectorRow.querySelectorAll("button")]
        .find((entry) => entry.textContent === "Allow")!
        .click(),
    );
    await vi.waitFor(() => expect(container.querySelector('[role="status"]')).toBeNull());

    let finish!: (value: { before: string; after: string }) => void;
    rpcMock.approvalRules.preview.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => button(container, "Test rule")!.click());
    await act(async () =>
      [...connectorRow.querySelectorAll("button")]
        .find((entry) => entry.textContent === "Remove")!
        .click(),
    );
    await vi.waitFor(() => expect(container.querySelector('[aria-label="Gmail"]')).toBeNull());
    await act(async () => finish({ before: "deny", after: "deny" }));
    expect(container.querySelector('[role="status"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("sets the mode, and lists Auto only when an approval model is there", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  rpcMock.approvalRules.list.mockResolvedValue([]);
  rpcMock.autoReview.get.mockResolvedValue({ ...settings, checkerAvailable: false });
  rpcMock.autoReview.set.mockResolvedValue({ ...settings, mode: "never", skipApprovals: true });
  const { container, root } = await render();
  try {
    await vi.waitFor(() =>
      expect(button(container, "Ask")?.getAttribute("aria-pressed")).toBe("true"),
    );
    expect(button(container, "Auto")).toBeUndefined();
    await act(async () => button(container, "Never ask")?.click());
    expect(rpcMock.autoReview.set).toHaveBeenLastCalledWith({ scope: "account", mode: "never" });
    await vi.waitFor(() =>
      expect(button(container, "Never ask")?.getAttribute("aria-pressed")).toBe("true"),
    );
    // No rules yet, so the rule list stays out of the way.
    expect(container.querySelector('[data-testid="approval-rules"]')).toBeNull();
    await act(async () => root.unmount());
  } finally {
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("blocks or removes an allowed tool", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const allowed = {
    id: "rule-1",
    effect: "always_allow",
    matchKind: "tool",
    matchValue: "GMAIL_SEND_EMAIL",
    createdAt: "2026-10-25T00:00:00.000Z",
  };
  rpcMock.approvalRules.list.mockResolvedValue([allowed]);
  rpcMock.approvalRules.set.mockResolvedValue({ ...allowed, id: "rule-2", effect: "deny" });
  rpcMock.approvalRules.remove.mockResolvedValue({ ok: true });
  rpcMock.autoReview.get.mockResolvedValue(settings);
  const { container, root } = await render();
  const rules = '[data-testid="approval-rules"]';
  try {
    await vi.waitFor(() => expect(container.textContent).toContain("Gmail send email"));
    expect(button(container, "Allow", rules)?.getAttribute("aria-pressed")).toBe("true");
    await act(async () => button(container, "Block", rules)?.click());
    expect(rpcMock.approvalRules.set).toHaveBeenLastCalledWith({
      scope: "account",
      effect: "deny",
      matchKind: "tool",
      matchValue: "GMAIL_SEND_EMAIL",
    });
    await vi.waitFor(() =>
      expect(button(container, "Block", rules)?.getAttribute("aria-pressed")).toBe("true"),
    );
    await act(async () => button(container, "Remove", rules)?.click());
    expect(rpcMock.approvalRules.remove).toHaveBeenLastCalledWith({
      scope: "account",
      id: "rule-2",
    });
    await vi.waitFor(() => expect(container.querySelector(rules)).toBeNull());
    await act(async () => root.unmount());
  } finally {
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("shows what older rules do, including email and purchase ones", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  rpcMock.approvalRules.list.mockResolvedValue([
    { id: "rule-1", effect: "require_approval", matchKind: "tool", matchValue: "send_email" },
    { id: "rule-2", effect: "require_approval", matchKind: "category", matchValue: "email" },
    { id: "rule-3", effect: "always_allow", matchKind: "category", matchValue: "purchase" },
  ]);
  rpcMock.autoReview.get.mockResolvedValue(settings);
  const { container, root } = await render();
  const rules = '[data-testid="approval-rules"]';
  try {
    await vi.waitFor(() => expect(container.textContent).toContain("Send email"));
    expect(button(container, "Ask", rules)?.getAttribute("aria-pressed")).toBe("true");
    for (const [name, effect] of [
      ["Email", "Ask"],
      ["Purchase", "Allow"],
    ]) {
      const label = [...container.querySelectorAll(`${rules} .text-foreground`)].find(
        (entry) => entry.textContent === name,
      );
      const row = label?.parentElement?.parentElement;
      expect(row?.textContent).toContain(effect);
      expect(row?.querySelector("[aria-pressed]")).toBeNull();
      expect([...row!.querySelectorAll("button")].map((entry) => entry.textContent)).toEqual([
        "Preview",
        "Remove",
      ]);
    }
    await act(async () => root.unmount());
  } finally {
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("keeps a saved mode when the revisit's older background read lands after it", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  rpcMock.approvalRules.list.mockResolvedValue([]);
  rpcMock.autoReview.get.mockResolvedValueOnce(settings);
  rpcMock.autoReview.set.mockResolvedValue({ ...settings, mode: "never", skipApprovals: true });
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
  const neverAsk = () => button(container, "Never ask");
  try {
    const first = await mount();
    await vi.waitFor(() =>
      expect(button(container, "Ask")?.getAttribute("aria-pressed")).toBe("true"),
    );
    await act(async () => first.unmount());

    let resolveRead: (value: typeof settings) => void = () => undefined;
    rpcMock.autoReview.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    const second = await mount();
    // Cached, so the mode can change while the refresh is out.
    expect(rpcMock.autoReview.get).toHaveBeenCalledTimes(2);
    await act(async () => neverAsk()?.click());
    await vi.waitFor(() => expect(neverAsk()?.getAttribute("aria-pressed")).toBe("true"));
    await act(async () => resolveRead(settings));
    // Query updates reach components on a timer; let any late write land.
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(neverAsk()?.getAttribute("aria-pressed")).toBe("true");
    await act(async () => second.unmount());
  } finally {
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("reads and writes a Space's own approvals apart from the account's", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const rule = {
    id: "rule-1",
    effect: "always_allow",
    matchKind: "tool",
    matchValue: "send_email",
  };
  rpcMock.approvalRules.list.mockImplementation(async ({ scope }: { scope: string }) =>
    scope === "space" ? [rule] : [],
  );
  rpcMock.approvalRules.remove.mockResolvedValue({ ok: true });
  rpcMock.autoReview.get.mockResolvedValue(settings);
  rpcMock.autoReview.set.mockResolvedValue({ ...settings, mode: "auto", enabled: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const show = (scope: "account" | "space") =>
    act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ApprovalRulesSettings scope={scope} />
        </QueryClientProvider>,
      );
    });
  try {
    await show("space");
    await vi.waitFor(() => expect(button(container, "Remove")).toBeDefined());
    expect(rpcMock.autoReview.get).toHaveBeenCalledWith({ scope: "space" }, expect.anything());
    await act(async () => button(container, "Auto")?.click());
    expect(rpcMock.autoReview.set).toHaveBeenLastCalledWith({ scope: "space", mode: "auto" });
    await act(async () => button(container, "Remove")?.click());
    expect(rpcMock.approvalRules.remove).toHaveBeenLastCalledWith({
      scope: "space",
      id: "rule-1",
    });

    await show("account");
    await vi.waitFor(() =>
      expect(rpcMock.approvalRules.list).toHaveBeenCalledWith(
        { scope: "account" },
        expect.anything(),
      ),
    );
    await vi.waitFor(() => expect(button(container, "Remove")).toBeUndefined());
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("switches an allowed tool back to Ask", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const rule = { id: "tool", effect: "always_allow", matchKind: "tool", matchValue: "write_file" };
  rpcMock.approvalRules.list.mockResolvedValue([rule]);
  rpcMock.autoReview.get.mockResolvedValue(settings);
  rpcMock.approvalRules.set.mockResolvedValue({ ...rule, effect: "require_approval" });
  const { container, root } = await render();
  try {
    await vi.waitFor(() =>
      expect(button(container, "Ask", '[data-testid="approval-rules"]')).toBeDefined(),
    );
    await act(async () => button(container, "Ask", '[data-testid="approval-rules"]')!.click());
    expect(rpcMock.approvalRules.set).toHaveBeenCalledWith({
      scope: "account",
      effect: "require_approval",
      matchKind: "tool",
      matchValue: "write_file",
    });
    expect(
      button(container, "Ask", '[data-testid="approval-rules"]')!.getAttribute("aria-pressed"),
    ).toBe("true");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("adds an explicit tool rule without waiting for an approval card", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  rpcMock.approvalRules.list.mockResolvedValue([]);
  rpcMock.autoReview.get.mockResolvedValue(settings);
  rpcMock.approvalRules.set.mockResolvedValue({
    id: "new",
    effect: "require_approval",
    matchKind: "tool",
    matchValue: "write_file",
  });
  const { container, root } = await render("space");
  try {
    await vi.waitFor(() => expect(button(container, "Add rule")!.disabled).toBe(false));
    await act(async () => button(container, "Add rule")!.click());
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Tool name"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        " write_file ",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(rpcMock.approvalRules.set).toHaveBeenCalledWith({
      scope: "space",
      effect: "require_approval",
      matchKind: "tool",
      matchValue: "write_file",
    });
    expect(container.querySelector("form")).toBeNull();
    expect(container.textContent).toContain("Write file");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
