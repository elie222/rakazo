// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & {
    variant?: string;
    size?: string;
  }) => <button type="button" {...props} />,
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  OptionSelect: ({
    options,
    value,
    onValueChange,
    ...props
  }: ComponentProps<"select"> & {
    options: ReadonlyArray<{ value: string; label: string }>;
    onValueChange?: (value: string) => void;
  }) => (
    <select {...props} value={value} onChange={(event) => onValueChange?.(event.target.value)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

import { ConversationCompactionRow, ToolCallLimitRow } from "./bot-settings-sections";

const roots: Array<{ unmount: () => void }> = [];
afterEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
  roots.splice(0).forEach((root) => {
    act(() => root.unmount());
  });
  document.body.innerHTML = "";
});

function render(element: ReactNode) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  roots.push(root);
  return container;
}

async function setInput(input: HTMLInputElement, value: string) {
  await act(async () => {
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function blur(input: HTMLInputElement) {
  await act(async () => {
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

describe("ConversationCompactionRow", () => {
  it("saves a preset without keeping a custom threshold", async () => {
    const onChange = vi.fn();
    const container = render(
      <ConversationCompactionRow
        id="compaction"
        mode="automatic"
        customTokens={null}
        onChange={onChange}
      />,
    );
    const select = container.querySelector<HTMLSelectElement>(
      '[data-testid="bot-conversation-compaction"]',
    )!;
    await act(async () => {
      select.value = "earlier";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("earlier", null);
  });

  it("shows the custom threshold and saves a whole number", async () => {
    const onChange = vi.fn();
    const container = render(
      <ConversationCompactionRow
        id="compaction"
        mode="custom"
        customTokens={120_000}
        onChange={onChange}
      />,
    );
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="bot-conversation-compaction-tokens"]',
    )!;
    expect(input.value).toBe("120000");
    await setInput(input, "150000");
    await blur(input);
    expect(onChange).toHaveBeenCalledWith("custom", 150_000);
  });

  it("applies the 100K and 200K presets", async () => {
    const onChange = vi.fn();
    const container = render(
      <ConversationCompactionRow
        id="compaction"
        mode="custom"
        customTokens={120_000}
        onChange={onChange}
      />,
    );
    const preset = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "100K",
    );
    await act(async () => preset?.click());
    expect(onChange).toHaveBeenCalledWith("custom", 100_000);
  });

  it("refuses a threshold outside 20K through 1M", async () => {
    const onChange = vi.fn();
    const container = render(
      <ConversationCompactionRow
        id="compaction"
        mode="custom"
        customTokens={120_000}
        onChange={onChange}
      />,
    );
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="bot-conversation-compaction-tokens"]',
    )!;
    await setInput(input, "19999");
    await blur(input);
    expect(onChange).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Use a whole number from 20000 to 1000000.");
  });
});

describe("ToolCallLimitRow", () => {
  it("clears an empty field to no limit", async () => {
    const onCommit = vi.fn();
    const container = render(<ToolCallLimitRow id="calls" value={80} onCommit={onCommit} />);
    const input = container.querySelector<HTMLInputElement>('[data-testid="bot-tool-call-limit"]')!;
    await setInput(input, "");
    await blur(input);
    expect(onCommit).toHaveBeenCalledWith(null);
  });

  it("commits a whole number and refuses zero", async () => {
    const onCommit = vi.fn();
    const container = render(<ToolCallLimitRow id="calls" value={null} onCommit={onCommit} />);
    const input = container.querySelector<HTMLInputElement>('[data-testid="bot-tool-call-limit"]')!;
    expect(input.value).toBe("");
    await setInput(input, "42");
    await blur(input);
    expect(onCommit).toHaveBeenCalledWith(42);

    const second = render(<ToolCallLimitRow id="calls-2" value={null} onCommit={onCommit} />);
    const zero = second.querySelector<HTMLInputElement>('[data-testid="bot-tool-call-limit"]')!;
    await setInput(zero, "0");
    await blur(zero);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(second.textContent).toContain("Use a whole number from 1 to 1000.");
  });
});
