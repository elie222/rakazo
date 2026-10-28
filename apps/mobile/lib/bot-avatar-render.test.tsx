// @vitest-environment jsdom

import {
  avatarIdentitySeed,
  LOGO_BODY_PATH,
  logoAvatarFrame,
  logoAvatarTraits,
  organicAvatarPath,
  seededLogoAvatarColor,
  shippedBotAvatarShapePath,
} from "@rakazo/core";
import { botEyeColor } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BotAvatar } from "../components/bot-avatar";
import { mobileLogoAvatarActivity } from "./logo-avatar-activity";

const nativeProps = vi.hoisted(() => [] as Array<() => Record<string, unknown>>);

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => undefined }) },
  Pressable: ({ children }: { children?: ReactNode }) =>
    createElement("button", { type: "button" }, children),
  Image: ({ source }: { source: { uri: string } }) => createElement("img", { src: source.uri }),
}));

vi.mock("react-native-reanimated", () => {
  const passthrough = ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children);
  return {
    default: {
      View: passthrough,
      createAnimatedComponent: (component: unknown) => component,
    },
    cancelAnimation: () => undefined,
    Easing: { linear: (value: number) => value, inOut: (value: unknown) => value, cubic: 0 },
    ReduceMotion: { Never: "never" },
    withSpring: (value: unknown) => value,
    useAnimatedProps: (sample: () => Record<string, unknown>) => {
      nativeProps.push(sample);
      return {};
    },
    useDerivedValue: (sample: () => unknown) => ({ value: sample() }),
    useAnimatedStyle: () => ({}),
    useReducedMotion: () => true,
    useSharedValue: (value: number) => ({ value }),
    withRepeat: (value: unknown) => value,
    withTiming: (value: unknown) => value,
  };
});

vi.mock("react-native-svg", () => {
  const element =
    (tag: string) =>
    ({
      children,
      ...props
    }: {
      children?: ReactNode;
      d?: string;
      fill?: string;
      stopColor?: string;
    }) =>
      createElement(
        tag,
        { "data-d": props.d, "data-fill": props.fill, "data-stop-color": props.stopColor },
        children,
      );
  return {
    default: element("svg"),
    Ellipse: element("ellipse"),
    G: element("g"),
    Path: element("path"),
    Rect: element("rect"),
    Defs: element("defs"),
    ClipPath: element("clipPath"),
    Mask: element("mask"),
    LinearGradient: element("linearGradient"),
    RadialGradient: element("radialGradient"),
    Stop: element("stop"),
  };
});

vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("./native", () => ({
  useMobileTokens: () => ({
    background: "#FFF",
    foreground: "#141414",
    sidebar: "#F1F1F1",
    border: "#CCCCCC",
    workingDot: "#3FA266",
    secondary: "#7676801F",
  }),
}));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));

describe("BotAvatar", () => {
  it("renders the thinking pose only while the production mobile store has a genuine marker", () => {
    mobileLogoAvatarActivity.hydrate("native-test", {
      threadId: "native-thread",
      cursor: 0,
      botId: "bot-1",
      run: { id: "native-run", botId: "bot-1", status: "running", trigger: "user" },
    });
    render("#10B981", "rakazo");
    const latestEye = () =>
      nativeProps
        .map((sample) => sample())
        .filter((props) => typeof props.cx === "number")
        .slice(-2)[0]!;
    const send = (seq: number, thinking: boolean) =>
      act(() =>
        mobileLogoAvatarActivity.apply("native-test", {
          threadId: "native-thread",
          seq,
          botId: "bot-1",
          runId: "native-run",
          type: "thread.meta",
          payload: { activity: { thinking } },
        }),
      );
    send(1, true);
    const frame = logoAvatarFrame("thinking", logoAvatarTraits("bot-1", "#10B981"), 0, true);
    expect(latestEye()).toMatchObject({ cx: 40.5 + frame.eyeX, cy: 49 + frame.eyeY });
    send(2, false);
    expect(latestEye()).toMatchObject({ cx: 40.5, cy: 49 });
  });

  it("uses the same shared seed colour as SSR for a bot without a saved colour", () => {
    const node = render("", "rakazo");
    expect(
      node.querySelector(`stop[data-stop-color="${seededLogoAvatarColor("bot-1").toLowerCase()}"]`),
    ).not.toBeNull();
  });
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    vi.unstubAllGlobals();
    nativeProps.length = 0;
    mobileLogoAvatarActivity.clear();
  });

  function render(color: string, avatarSet?: "organic" | "rakazo") {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() =>
      root?.render(<BotAvatar color={color} avatarSet={avatarSet} identity="bot-1" size={42} />),
    );
    return container;
  }

  const bodies = (view: HTMLElement) =>
    Array.from(view.querySelectorAll("path"), (path) => path.dataset.d);

  it("draws a plain-colour bot with the organic body for its identity", () => {
    const view = render("#3EC5A8");
    expect(bodies(view)).toEqual([organicAvatarPath(avatarIdentitySeed("bot-1"))]);
    // Its eyes take the shared eye ink, the same as a group title's still faces.
    expect(Array.from(view.querySelectorAll("rect"), (eye) => eye.dataset.fill)).toEqual([
      botEyeColor,
      botEyeColor,
    ]);
    expect(view.querySelector("img")).toBeNull();
    expect(view.querySelector("ellipse")).toBeNull();
  });

  it("keeps a picture", () => {
    const view = render("data:image/png;base64,abc");
    expect(view.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,abc");
    expect(bodies(view)).toEqual([]);
  });

  it("keeps a shape picked in Avatar Studio", () => {
    const view = render("#8B5CF6::shape_3");
    expect(bodies(view)).toEqual([shippedBotAvatarShapePath(3)]);
    expect(view.querySelectorAll("ellipse")).toHaveLength(2);
  });
  it("draws the explicitly selected Rakazo set as paths and gradients without a raster image", () => {
    const view = render("#3EC5A8", "rakazo");
    expect(bodies(view)).toContain(LOGO_BODY_PATH);
    expect(bodies(view)).not.toContain(organicAvatarPath(avatarIdentitySeed("bot-1")));
    expect(view.querySelector("img, image")).toBeNull();
    expect(view.querySelectorAll("ellipse")).toHaveLength(2);
    expect(view.querySelector("radialGradient")).not.toBeNull();
  });

  it("keeps a custom picture when the stored set is Rakazo", () => {
    const view = render("data:image/png;base64,abc", "rakazo");
    expect(view.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,abc");
    expect(bodies(view)).toEqual([]);
  });

  it("keeps an explicitly selected original shape when the stored set is Rakazo", () => {
    const view = render("#8B5CF6::shape_3", "rakazo");
    expect(bodies(view)).toEqual([shippedBotAvatarShapePath(3)]);
  });
  it("updates native SVG hosts with finite six-value matrices and numeric eye props", () => {
    render("#3EC5A8", "rakazo");
    const updates = nativeProps.map((sample) => sample());
    const matrices = updates.flatMap((update) =>
      Array.isArray(update.matrix) ? [update.matrix] : [],
    );
    expect(matrices).toHaveLength(5);
    for (const matrix of matrices) {
      expect(matrix).toHaveLength(6);
      expect(matrix.every(Number.isFinite)).toBe(true);
    }
    expect(updates.filter((update) => "cx" in update)).toHaveLength(2);
    expect(updates.every((update) => !("transform" in update))).toBe(true);
  });

  it("keeps eyes legible on a saved dark body in the light theme", () => {
    const view = render("#101014", "rakazo");
    expect(
      Array.from(view.querySelectorAll("ellipse"), (eye) => eye.getAttribute("data-fill")),
    ).toEqual(["#FFF", "#FFF"]);
  });
});
