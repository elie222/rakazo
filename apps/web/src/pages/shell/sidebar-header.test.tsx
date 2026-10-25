// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useCreateMenu } from "./sidebar-header";

// The header's copy is not under test.
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

function Probe() {
  const [open, setOpen] = useCreateMenu();
  return (
    <button type="button" onClick={() => setOpen(false)}>
      {open ? "open" : "closed"}
    </button>
  );
}

it("keeps Cmd/Ctrl-N pressed before the sidebar shows, so the menu opens with it", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Probe />));
    expect(host.textContent).toBe("closed");
    const press = new KeyboardEvent("keydown", { key: "n", ctrlKey: true, cancelable: true });
    await act(async () => window.dispatchEvent(press));
    expect(press.defaultPrevented).toBe(true);
    expect(host.textContent).toBe("open");
    await act(async () => host.querySelector("button")!.click());
    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "n", ctrlKey: true, shiftKey: true }),
      ),
    );
    expect(host.textContent).toBe("closed");
  } finally {
    await act(async () => root.unmount());
  }
});
