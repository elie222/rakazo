// @vitest-environment jsdom

import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useComposerModelShortcuts } from "./use-composer-model-shortcuts";

type Shortcuts = ReturnType<typeof useComposerModelShortcuts>;

describe("useComposerModelShortcuts", () => {
  let root: Root;
  let latest: Shortcuts;

  function Harness(props: { botId: string | undefined; enabled: boolean }) {
    latest = useComposerModelShortcuts(props);
    return null;
  }
  const render = (props: { botId: string | undefined; enabled: boolean }) =>
    act(() => root.render(<Harness {...props} />));

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    root = createRoot(document.createElement("div"));
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it("toggles the list and closes it for good when the chat changes", () => {
    render({ botId: "a", enabled: true });
    act(() => expect(latest.run("model-picker")).toBe(true));
    expect(latest.open).toBe(true);
    act(() => expect(latest.run("model-picker")).toBe(true));
    expect(latest.open).toBe(false);

    act(() => latest.run("model-picker"));
    render({ botId: "b", enabled: true });
    expect(latest.open).toBe(false);
    render({ botId: "a", enabled: true });
    expect(latest.open).toBe(false);
  });

  it("leaves the keys alone while the button cannot be used, and remembers nothing for later", () => {
    render({ botId: "a", enabled: false });
    act(() => expect(latest.run("model-picker")).toBe(false));
    expect(latest.run("thinking-level")).toBe(false);
    render({ botId: "a", enabled: true });
    expect(latest.open).toBe(false);
    render({ botId: undefined, enabled: true });
    act(() => expect(latest.run("model-picker")).toBe(false));
  });

  it("steps thinking through what the picker registered", () => {
    render({ botId: "a", enabled: true });
    expect(latest.run("thinking-level")).toBe(false);
    const step = vi.fn(() => true);
    latest.pickerProps.onThinkingStepChange(step);
    expect(latest.run("thinking-level")).toBe(true);
    expect(step).toHaveBeenCalledOnce();
  });
});
