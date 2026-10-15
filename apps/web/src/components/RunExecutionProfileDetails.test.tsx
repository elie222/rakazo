// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: () => null,
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: () => <button type="button">Run details</button>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { RunExecutionProfileDetails } from "./RunExecutionProfileDetails";

it("renders only immutable public run attribution and stays absent for default runs", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    act(() => root.render(<RunExecutionProfileDetails />));
    expect(container.textContent).toBe("");
    act(() =>
      root.render(
        <RunExecutionProfileDetails
          profile={{
            id: "private-profile-id",
            name: "Review",
            revision: 3,
            harness: "claude",
            provider: "gateway",
            modelId: "test-model",
            accountLabel: "Previous account label",
          }}
        />,
      ),
    );
    expect(container.textContent).toContain("Claude Agent");
    expect(container.textContent).toContain("Review · v3");
    expect(container.textContent).toContain("Previous account label");
    expect(container.textContent).not.toContain("private-profile-id");
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
