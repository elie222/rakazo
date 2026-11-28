// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { remountShellForSpace, useSpaceEpoch } from "../space-switch";
import { useSidebarScroll } from "./use-sidebar-scroll";

it("keeps the bot list scrolled when opening a chat in another Space remounts the shell", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);

  function ShellPage() {
    const epoch = useSpaceEpoch();
    const scrollRef = useSidebarScroll();
    return <div key={epoch} ref={scrollRef} />;
  }

  try {
    await act(async () => root.render(<ShellPage />));
    const original = container.firstElementChild!;
    original.scrollTop = 640;

    await act(async () => remountShellForSpace(() => true));

    const remounted = container.firstElementChild!;
    expect(remounted).not.toBe(original);
    expect(remounted.scrollTop).toBe(640);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
