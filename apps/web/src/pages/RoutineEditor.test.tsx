// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("../lib/rpc", () => ({
  rpc: { models: { credentials: async () => [], list: async () => [] } },
}));
vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray) => parts.join(""),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ i18n: { locale: "en" }, t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => {
  const Passthrough = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const Item = ({ children, disabled }: { children?: ReactNode; disabled?: boolean }) => (
    <button type="button" role="menuitem" disabled={disabled}>
      {children}
    </button>
  );
  return {
    Button: ({ children }: ComponentProps<"button">) => <button type="button">{children}</button>,
    DropdownMenu: Passthrough,
    DropdownMenuContent: Passthrough,
    DropdownMenuItem: Item,
    DropdownMenuSub: Passthrough,
    DropdownMenuSubContent: Passthrough,
    DropdownMenuSubTrigger: Item,
    DropdownMenuTrigger: Passthrough,
    Input: () => <input />,
    NativeSelect: Passthrough,
    NativeSelectOption: Passthrough,
    Popover: Passthrough,
    PopoverContent: Passthrough,
    PopoverTrigger: Passthrough,
    Switch: () => <input type="checkbox" />,
    Textarea: () => <textarea />,
  };
});

import { emptyRoutineDraft, RoutineEditor } from "./RoutineEditor";

it("offers only triggers that can be added", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <RoutineEditor
        draft={emptyRoutineDraft()}
        onChange={() => {}}
        editing={null}
        timezone="UTC"
        webhook={{ path: "", secret: null, configured: true }}
        githubPath=""
        messageProviders={["slack"]}
        saving={false}
        running={false}
        error={null}
        onBack={() => {}}
        onClose={() => {}}
        onSave={() => {}}
        onTestRun={() => {}}
        onDelete={() => {}}
        onEnsureWebhook={async () => {}}
      />,
    ),
  );

  const items = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
  expect(items.length).toBeGreaterThan(0);
  expect(items.filter((item) => item.disabled).map((item) => item.textContent)).toEqual([]);

  act(() => root.unmount());
  vi.unstubAllGlobals();
});
