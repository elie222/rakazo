// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ParallelWorkRow } from "./bot-settings-sections";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/ui-web", () => ({
  Input: (props: ComponentProps<"input">) => <input {...props} />,
}));

const roots: Array<{ unmount: () => void }> = [];
afterEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
  roots.splice(0).forEach((root) => {
    act(() => root.unmount());
  });
  document.body.innerHTML = "";
});

function renderRow(value: number | null, onCommit = vi.fn()) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(<ParallelWorkRow id="work" value={value} onCommit={onCommit} />);
  });
  roots.push(root);
  return {
    container,
    input: container.querySelector<HTMLInputElement>('[data-testid="bot-parallel-work"]')!,
    onCommit,
    confirm: (next: number | null) =>
      act(() => {
        root.render(<ParallelWorkRow id="work" value={next} onCommit={onCommit} />);
      }),
  };
}

async function type(input: HTMLInputElement, value: string) {
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

describe("ParallelWorkRow", () => {
  it("shows the default until one is set and commits a whole number", async () => {
    const { input, onCommit, confirm } = renderRow(null);
    expect(input.value).toBe("3");
    await type(input, "5");
    await blur(input);
    expect(onCommit).toHaveBeenCalledWith(5);
    confirm(5);
    expect(input.value).toBe("5");
  });

  it("stores the default as following it", async () => {
    const { input, onCommit } = renderRow(5);
    await type(input, "3");
    await blur(input);
    expect(onCommit).toHaveBeenCalledWith(null);
  });

  it("refuses a value outside the range and keeps it for correction", async () => {
    const { container, input, onCommit } = renderRow(null);
    await type(input, "9");
    await blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe("9");
    expect(container.textContent).toContain("Use a whole number from 1 to 8.");
  });
});
