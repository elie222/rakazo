// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BotMemoryTabs } from "./bot-memory-tabs";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/ui-web", () => ({
  Field: ({ children, ...props }: ComponentProps<"div">) => <div {...props}>{children}</div>,
  FieldLabel: ({ children, htmlFor, ...props }: ComponentProps<"label">) => (
    <label htmlFor={htmlFor} {...props}>
      {children}
    </label>
  ),
  FieldDescription: ({ children, ...props }: ComponentProps<"p">) => <p {...props}>{children}</p>,
  FieldError: ({ children, ...props }: ComponentProps<"div">) => <div {...props}>{children}</div>,
  Button: (props: ComponentProps<"button">) => <button type="button" {...props} />,
  Tabs: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
  TabsContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Switch: ({
    checked,
    onCheckedChange,
    id,
  }: ComponentProps<"input"> & { checked?: boolean; onCheckedChange?: (on: boolean) => void }) => (
    <input
      id={id}
      type="checkbox"
      checked={checked}
      onChange={(event) => onCheckedChange?.(event.target.checked)}
    />
  ),
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: [] }) }));
vi.mock("../../../lib/query/query", () => ({
  useSpaceQueries: () => ({
    memory: {
      dreams: {
        queryOptions: () => ({ queryKey: ["dreams"], queryFn: async () => [] }),
        queryKey: () => ["dreams"],
      },
    },
  }),
  useSave: () => ({ run: vi.fn(), pending: false, error: null }),
}));
vi.mock("../../space/KnowledgeSection", () => ({
  MemoryDocumentList: ({ input }: { input: { botId?: string; scope: string } }) => (
    <span data-testid="memory-list">{input.scope === "bot" ? input.botId : "shared"}</span>
  ),
}));

const roots: Array<{ unmount: () => void }> = [];
afterEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
  roots.splice(0).forEach((root) => {
    act(() => root.unmount());
  });
  document.body.innerHTML = "";
});

function render(useOwnMemory = true, useSharedMemory = true) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onSave = vi.fn();
  act(() => {
    root.render(
      <BotMemoryTabs
        botId="bot-1"
        useOwnMemory={useOwnMemory}
        useSharedMemory={useSharedMemory}
        onSave={onSave}
      />,
    );
  });
  roots.push(root);
  return { container, onSave };
}

describe("BotMemoryTabs", () => {
  it("offers both banks with their switches on", () => {
    const { container } = render();
    expect(container.textContent).toContain("About you");
    expect(container.textContent).toContain("This bot");
    const [shared, own] = [
      ...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ];
    expect(shared!.checked).toBe(true);
    expect(own!.checked).toBe(true);
    expect(container.textContent).toContain("shared");
    expect(container.textContent).toContain("bot-1");
  });

  it("turns each bank off through the save", async () => {
    const { container, onSave } = render();
    const [shared, own] = [
      ...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ];
    await act(async () => {
      shared!.click();
      own!.click();
    });
    expect(onSave).toHaveBeenCalledWith({ useSharedMemory: false });
    expect(onSave).toHaveBeenCalledWith({ useOwnMemory: false });
  });
});
