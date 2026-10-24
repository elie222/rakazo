// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
}));

const { ImportSetupCard } = await import("./import-setup-card");

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("the import setup checklist", () => {
  it("lists what each item needs and opens where it is finished", () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const onOpen = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() =>
      root!.render(
        <ImportSetupCard
          onOpen={onOpen}
          block={{
            kind: "import_setup",
            items: [
              { kind: "model", title: "openrouter/example", provider: "openrouter" },
              {
                kind: "mcp",
                serverId: "server-1",
                name: "files",
                needs: [
                  { kind: "program", name: "npx" },
                  { kind: "env", names: ["EXAMPLE_TOKEN"] },
                ],
              },
              { kind: "routine", routineId: "routine-1", name: "morning" },
              {
                kind: "skill",
                name: "triage",
                needs: [{ kind: "requires", names: ["gh", "curl"] }],
              },
            ],
          }}
        />,
      ),
    );
    const rows = [...container.querySelectorAll("li")].map((row) =>
      [...row.querySelectorAll("p")].map((line) => line.textContent),
    );
    expect(rows).toEqual([
      ["openrouter/example", "API key for openrouter"],
      ["files", "Program: npx · Env: EXAMPLE_TOKEN"],
      ["morning", "Paused"],
      ["triage", "Needs: gh, curl"],
    ]);
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Open openrouter/example",
      "Open files",
      "Open morning",
    ]);
    for (const button of buttons) act(() => button.click());
    expect(onOpen.mock.calls.map(([target]) => target)).toEqual([
      { kind: "models" },
      { kind: "mcp" },
      { kind: "routine", routineId: "routine-1" },
    ]);
  });
});
