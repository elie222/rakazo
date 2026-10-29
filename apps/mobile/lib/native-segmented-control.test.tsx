// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeSegmentedControl } from "../components/native-segmented-control";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const state = vi.hoisted(() => ({ missing: "", os: "android", imports: 0 }));
const loading = vi.hoisted(() => {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
});
vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return state.os;
    },
  },
}));
vi.mock("./compose-available", () => ({
  isComposeViewAvailable: (name: string) => name !== state.missing,
}));
vi.mock("../components/segmented-pills", () => ({
  SegmentedPills: (props: unknown) => <div data-fallback={JSON.stringify(props)} />,
}));
vi.mock("../components/native-segmented-control-compose", async () => {
  state.imports++;
  await loading.promise;
  return {
    default: ({ accessibilityLabel }: { accessibilityLabel: string }) => (
      <div>{accessibilityLabel}</div>
    ),
  };
});

const props = {
  accessibilityLabel: "Appearance",
  value: "system",
  onChange: vi.fn(),
  options: [
    { value: "system", label: "System" },
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
  ],
  disabled: true,
};
let root: ReturnType<typeof createRoot>;
afterEach(async () => {
  await act(async () => root.unmount());
});
async function render(children: ReactNode) {
  const container = document.createElement("div");
  root = createRoot(container);
  await act(async () => root.render(children));
  return container;
}

describe("Compose availability guard", () => {
  it.each([
    "HostView",
    "SingleChoiceSegmentedButtonRowView",
    "SegmentedButtonView",
    "SlotView",
    "TextView",
  ])("preserves the fallback without importing adapters when %s is missing", async (missing) => {
    state.missing = missing;
    const container = await render(<NativeSegmentedControl {...props} />);
    expect(
      JSON.parse(container.firstElementChild?.getAttribute("data-fallback") ?? "null"),
    ).toEqual(JSON.parse(JSON.stringify(props)));
    expect(state.imports).toBe(0);
  });
  it("keeps non-Android platforms on the fallback", async () => {
    state.missing = "";
    state.os = "web";
    expect(
      (await render(<NativeSegmentedControl {...props} />)).querySelector("[data-fallback]"),
    ).not.toBeNull();
    expect(state.imports).toBe(0);
    state.os = "android";
  });
  it.each([4, 5])("uses pills for %i options without importing Compose", async (count) => {
    state.missing = "";
    const fallbackProps = {
      ...props,
      options: Array.from({ length: count }, (_, index) => ({
        value: String(index),
        label: `Option ${index}`,
      })),
    };
    const container = await render(<NativeSegmentedControl {...fallbackProps} />);
    expect(
      JSON.parse(container.firstElementChild?.getAttribute("data-fallback") ?? "null"),
    ).toEqual(JSON.parse(JSON.stringify(fallbackProps)));
    expect(state.imports).toBe(0);
  });
  it("keeps the fallback while loading and then renders Compose", async () => {
    state.missing = "";
    const container = await render(<NativeSegmentedControl {...props} />);
    expect(container.querySelector("[data-fallback]")).not.toBeNull();
    expect(state.imports).toBe(1);
    await act(async () => loading.resolve());
    expect(container.querySelector("[data-fallback]")).toBeNull();
    expect(container.textContent).toBe("Appearance");
  });
});
