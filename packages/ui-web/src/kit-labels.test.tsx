// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "./components/ui/dialog.js";
import { KitLabelsProvider } from "./components/ui/kit-labels.js";
import { Spinner } from "./components/ui/spinner.js";

const mounted: Array<() => void> = [];

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  vi.unstubAllGlobals();
});

function mount(node: ReactNode) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push(() => {
    act(() => root.unmount());
    container.remove();
  });
}

describe("kit labels", () => {
  it("names a dialog's close button in the caller's language", () => {
    mount(
      <KitLabelsProvider close="Schließen">
        <Dialog open>
          <DialogContent>
            <DialogTitle>Title</DialogTitle>
          </DialogContent>
        </Dialog>
      </KitLabelsProvider>,
    );
    const close = document.querySelector('[data-slot="dialog-close"]');
    expect(close?.textContent).toBe("Schließen");
  });

  it("names a dialog footer's close button in the caller's language", () => {
    mount(
      <KitLabelsProvider close="Schließen">
        <Dialog open>
          <DialogFooter showCloseButton>Body</DialogFooter>
        </Dialog>
      </KitLabelsProvider>,
    );
    expect(document.body.textContent).toContain("Schließen");
  });

  it("keeps the English default when a caller translates nothing", () => {
    mount(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Title</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    expect(document.querySelector('[data-slot="dialog-close"]')?.textContent).toBe("Close");
  });

  it("announces a spinner in the caller's language", () => {
    mount(
      <KitLabelsProvider loading="Lädt">
        <Spinner />
      </KitLabelsProvider>,
    );
    expect(document.querySelector('[data-slot="spinner"]')?.getAttribute("aria-label")).toBe(
      "Lädt",
    );
  });
});
