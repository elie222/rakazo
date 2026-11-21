// @vitest-environment jsdom

import type { LoginFieldInput } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The lingui macros need a transform that unit tests do not run, so supply `t` and `Trans` here.
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

import { LoginFieldsInput } from "./LoginFieldsInput";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function renderEditable(fields: LoginFieldInput[]) {
  await act(async () => {
    root.render(<LoginFieldsInput fields={fields} onChange={vi.fn()} />);
  });
}

/** The text a screen reader announces for the button's aria-describedby. */
function describedText(element: Element) {
  return (element.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ")
    .trim();
}

function removeButtons() {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button[aria-label="Remove"]'));
}

describe("LoginFieldsInput Remove buttons", () => {
  it("describes each Remove button by its own field's label", async () => {
    await renderEditable([
      { label: "Username", value: "", hidden: false },
      { label: "Password", value: "", hidden: true },
    ]);

    const [username, password] = removeButtons();
    expect(removeButtons()).toHaveLength(2);
    expect(describedText(username!)).toBe("Username");
    expect(describedText(password!)).toBe("Password");
  });

  it("describes a row with a blank label by the Value fallback its input uses", async () => {
    await renderEditable([
      { label: "Username", value: "", hidden: false },
      { label: "  ", value: "", hidden: false },
    ]);

    expect(describedText(removeButtons()[1]!)).toBe("Value");
  });
});
