// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspacePathRow } from "./bot-settings-sections";

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

function renderRow(value: string, onCommit = vi.fn()) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(<WorkspacePathRow id="ws" value={value} onCommit={onCommit} />);
  });
  roots.push(root);
  return {
    container,
    /** Play the parent applying a confirmed save back onto the row. */
    confirm: (next: string) =>
      act(() => {
        root.render(<WorkspacePathRow id="ws" value={next} onCommit={onCommit} />);
      }),
    input: container.querySelector<HTMLInputElement>('[data-testid="bot-workspace-path"]')!,
    onCommit,
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

describe("WorkspacePathRow", () => {
  it("commits the normalized folder on blur", async () => {
    const { confirm, input, onCommit } = renderRow("");
    await type(input, " projects\\website/ ");
    await blur(input);
    expect(onCommit).toHaveBeenCalledWith("projects/website");
    confirm("projects/website");
    expect(input.value).toBe("projects/website");
  });

  it("restores the default when emptied", async () => {
    const { input, onCommit } = renderRow("projects/website");
    await type(input, "  ");
    await blur(input);
    expect(onCommit).toHaveBeenCalledWith(null);
  });

  it("does not commit an unchanged value", async () => {
    const { input, onCommit } = renderRow("projects/website");
    await type(input, "projects/website/");
    await blur(input);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("keeps an escaping path and shows why", async () => {
    const { container, input, onCommit } = renderRow("");
    await type(input, "../secrets");
    await blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe("../secrets");
    expect(container.textContent).toContain('Use a relative folder path without ".." segments.');
  });
});
