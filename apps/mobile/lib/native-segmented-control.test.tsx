// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeSegmentedControl } from "../components/native-segmented-control";
import { NativeSegmentedControl as IosSegmentedControl } from "../components/native-segmented-control.ios";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const state = vi.hoisted(() => ({ missing: "", os: "android", imports: 0 }));
const hapticSelection = vi.hoisted(() => vi.fn());
const fallbackControl = vi.hoisted(() => vi.fn());
const composeControl = vi.hoisted(() => vi.fn());
const swiftPicker = vi.hoisted(() => vi.fn());
vi.mock("./haptics", () => ({ hapticSelection }));
vi.mock("./native", () => ({ useResolvedAppearance: () => "light" }));
vi.mock("@expo/ui/swift-ui", () => ({
  Host: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Picker: (props: { children: ReactNode }) => {
    swiftPicker(props);
    return <div>{props.children}</div>;
  },
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("@expo/ui/swift-ui/modifiers", () => {
  const modifier = (value: unknown) => value;
  return { disabled: modifier, labelsHidden: modifier, pickerStyle: modifier, tag: modifier };
});
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
  SegmentedPills: (props: unknown) => {
    fallbackControl(props);
    return <div data-fallback={JSON.stringify(props)} />;
  },
}));
vi.mock("../components/native-segmented-control-compose", async () => {
  state.imports++;
  await loading.promise;
  return {
    default: (props: { accessibilityLabel: string }) => {
      composeControl(props);
      return <div>{props.accessibilityLabel}</div>;
    },
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
beforeEach(() => {
  hapticSelection.mockClear();
  fallbackControl.mockClear();
  composeControl.mockClear();
  swiftPicker.mockClear();
  props.onChange.mockClear();
});
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

describe("segmented selection haptics", () => {
  it("emits once for a changed fallback selection and keeps a repeated selection silent", async () => {
    state.missing = "HostView";
    await render(<NativeSegmentedControl {...props} disabled={false} />);
    const select = fallbackControl.mock.lastCall?.[0].onChange;
    select("system");
    expect(hapticSelection).not.toHaveBeenCalled();
    expect(props.onChange).not.toHaveBeenCalled();
    select("light");
    expect(hapticSelection).toHaveBeenCalledTimes(1);
    expect(props.onChange).toHaveBeenCalledExactlyOnceWith("light");
    await act(async () =>
      root.render(<NativeSegmentedControl {...props} value="light" disabled={false} />),
    );
    fallbackControl.mock.lastCall?.[0].onChange("light");
    expect(hapticSelection).toHaveBeenCalledTimes(1);
    expect(props.onChange).toHaveBeenCalledTimes(1);
  });

  it("emits once through the loaded Compose callback", async () => {
    state.missing = "";
    await render(<NativeSegmentedControl {...props} disabled={false} />);
    const select = composeControl.mock.lastCall?.[0].onChange;
    select("system");
    expect(hapticSelection).not.toHaveBeenCalled();
    select("dark");
    expect(hapticSelection).toHaveBeenCalledTimes(1);
    expect(props.onChange).toHaveBeenCalledExactlyOnceWith("dark");
  });

  it("ignores disabled fallback and Compose selection callbacks", async () => {
    state.missing = "HostView";
    await render(<NativeSegmentedControl {...props} />);
    fallbackControl.mock.lastCall?.[0].onChange("light");
    state.missing = "";
    await act(async () => root.render(<NativeSegmentedControl {...props} />));
    composeControl.mock.lastCall?.[0].onChange("light");
    expect(hapticSelection).not.toHaveBeenCalled();
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it("emits once for a changed SwiftUI selection, ignoring repeats and unknown values", async () => {
    await render(<IosSegmentedControl {...props} disabled={false} />);
    const select = swiftPicker.mock.lastCall?.[0].onSelectionChange;
    select("system");
    select("missing");
    expect(hapticSelection).not.toHaveBeenCalled();
    select("light");
    expect(hapticSelection).toHaveBeenCalledTimes(1);
    expect(props.onChange).toHaveBeenCalledExactlyOnceWith("light");
    await act(async () =>
      root.render(<IosSegmentedControl {...props} value="light" disabled={false} />),
    );
    swiftPicker.mock.lastCall?.[0].onSelectionChange("light");
    expect(hapticSelection).toHaveBeenCalledTimes(1);
    expect(props.onChange).toHaveBeenCalledTimes(1);
  });

  it("keeps a disabled SwiftUI picker silent", async () => {
    await render(<IosSegmentedControl {...props} />);
    swiftPicker.mock.lastCall?.[0].onSelectionChange("light");
    expect(hapticSelection).not.toHaveBeenCalled();
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it("uses the same single feedback path for an unmatched iOS value", async () => {
    await render(<IosSegmentedControl {...props} value="unknown" disabled={false} />);
    fallbackControl.mock.lastCall?.[0].onChange("light");
    expect(hapticSelection).toHaveBeenCalledTimes(1);
    expect(props.onChange).toHaveBeenCalledExactlyOnceWith("light");
  });
});
