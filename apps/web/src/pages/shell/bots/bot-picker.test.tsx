// @vitest-environment jsdom

import type { Bot } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { BotCreatePicker } from "./bot-picker";

vi.mock("@lingui/react/macro", () => {
  const translate = (text: ReactNode) => (text === "New bot" ? "Nouveau bot" : text);
  return {
    useLingui: () => ({ t: (parts: TemplateStringsArray) => translate(parts[0]) }),
    Trans: ({ children }: { children: ReactNode }) => translate(children),
  };
});

vi.mock("@rakazo/ui-web", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    BotAvatar: () => null,
    Command: Container,
    CommandEmpty: Container,
    CommandGroup: Container,
    CommandList: Container,
    CommandSeparator: () => null,
    CommandItem: ({
      children,
      onSelect,
      "data-testid": testId,
    }: {
      children: ReactNode;
      onSelect: () => void;
      "data-testid": string;
    }) => (
      <div
        role="option"
        aria-selected={false}
        tabIndex={0}
        data-testid={testId}
        onClick={onSelect}
        onKeyDown={(event) => {
          if (event.key === "Enter") onSelect();
        }}
      >
        {children}
      </div>
    ),
  };
});

vi.mock("../../../components/IconTooltip", () => ({
  IconTooltip: ({ children }: { children: ReactNode }) => children,
}));

it("matches the French New bot label without losing English aliases or bot search", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const bots = [{ id: "research", name: "Research helper", color: "blue" }] as Bot[];
  const onCreateBot = vi.fn();
  const onOpenBot = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  try {
    await act(async () =>
      root.render(
        <BotCreatePicker
          bots={bots}
          onCreateBot={onCreateBot}
          onOpenBot={onOpenBot}
          onCreateGroup={vi.fn()}
          onCreateSpace={vi.fn()}
        />,
      ),
    );

    const input = container.querySelector("input")!;
    const row = (testId: string) =>
      container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    const search = (value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          input,
          value,
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });

    expect(row("create-new-bot")?.textContent).toBe("Nouveau bot");
    for (const query of ["Nouveau bot", "  NOUVEAU ", "bot nouveau", "new bot", "bot new"]) {
      await search(query);
      expect(row("create-new-bot")?.textContent).toBe("Nouveau bot");
    }
    await act(async () => row("create-new-bot")!.click());
    expect(onCreateBot).toHaveBeenCalledOnce();

    await search("research");
    expect(row("create-new-bot")).toBeNull();
    expect(row("picker-bot-research")?.textContent).toBe("Research helper");
    await act(async () => row("picker-bot-research")!.click());
    expect(onOpenBot).toHaveBeenCalledWith("research");

    await search("unrelated");
    expect(row("create-new-bot")).toBeNull();
    expect(row("picker-bot-research")).toBeNull();
    expect(row("create-new-group")).not.toBeNull();
    expect(row("create-new-space")).not.toBeNull();
    expect(onCreateBot).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
