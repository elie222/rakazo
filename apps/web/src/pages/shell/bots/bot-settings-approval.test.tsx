// @vitest-environment jsdom

import type { ChangeEvent, ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalModeRow } from "./bot-settings-sections";

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
  OptionSelect: ({
    value,
    options,
    onValueChange,
    disabled,
    "aria-label": label,
    "data-testid": testId,
  }: {
    value: string | null;
    options: ReadonlyArray<{ value: string; label: string }>;
    onValueChange: (value: string) => void;
    disabled?: boolean;
    "aria-label"?: string;
    "data-testid"?: string;
  }) => (
    <select
      aria-label={label}
      data-testid={testId}
      value={value ?? ""}
      disabled={disabled}
      onChange={(event: ChangeEvent<HTMLSelectElement>) => onValueChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
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

function renderRow(
  value: "ask" | "auto" | "never" | null,
  autoAvailable = true,
  onChange = vi.fn(),
) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <ApprovalModeRow id="mode" value={value} autoAvailable={autoAvailable} onChange={onChange} />,
    );
  });
  roots.push(root);
  const select = container.querySelector<HTMLSelectElement>('[data-testid="bot-approval-mode"]')!;
  return { container, select, onChange };
}

async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("ApprovalModeRow", () => {
  it("lists the four modes and clears back to the Space default", async () => {
    const { select, onChange } = renderRow("never");
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "Space default",
      "Ask",
      "Auto",
      "Never ask",
    ]);
    await choose(select, "");
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("says why Auto waits when the Space has no approval model", () => {
    const { container } = renderRow("auto", false);
    expect(container.textContent).toContain("Auto needs an approval model");
    const available = renderRow("auto", true);
    expect(available.container.textContent).not.toContain("Auto needs an approval model");
  });
});
