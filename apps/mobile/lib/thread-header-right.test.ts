import { describe, expect, it, vi } from "vitest";
import { threadHeaderRight } from "../components/thread-header-right";

vi.mock("expo-router", () => ({ router: { push: vi.fn() } }));
vi.mock("react-native", () => ({
  Animated: { View: "Animated.View" },
  Pressable: "Pressable",
  View: "View",
}));
vi.mock("react-native-reanimated", () => ({ useReducedMotion: () => false }));
vi.mock("../lib/native-controls", () => ({ iosAtLeast: vi.fn(() => false) }));
vi.mock("../lib/voice", () => ({
  getVoicePlaybackState: () => ({ status: "idle" }),
  subscribeVoicePlayback: () => () => undefined,
}));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));

import { iosAtLeast } from "../lib/native-controls";

const t = (text: string) => text;

type HeaderButton = { props: { accessibilityLabel?: string; onPress?: unknown } };

function headerButtons(options: ReturnType<typeof threadHeaderRight>): HeaderButton[] {
  // The navigation option takes header props; the tree walk only needs the element.
  const render = options.headerRight as unknown as (() => unknown) | undefined;
  const rendered = render?.() as { props?: { children?: unknown } } | null | undefined;
  const children = rendered?.props?.children;
  const list = Array.isArray(children) ? children : [children];
  return list.filter((child): child is HeaderButton =>
    Boolean(child && typeof child === "object" && "props" in (child as Record<string, unknown>)),
  );
}

describe("mobile voice chat header entry", () => {
  it("shows a phone button that opens the voice chat in a one-to-one chat", () => {
    const onOpenVoiceChat = vi.fn();
    const options = threadHeaderRight({
      botId: "bot-1",
      inGroup: false,
      readOnly: false,
      t,
      color: "#000",
      onGroupSettings: () => undefined,
      onOpenVoiceChat,
    });
    const phone = headerButtons(options).find(
      (button) => button.props.accessibilityLabel === "Voice chat",
    );
    expect(phone).toBeDefined();
    expect(phone?.props.onPress).toBe(onOpenVoiceChat);
  });

  it("lists the phone as a native header item on iOS 26", () => {
    vi.mocked(iosAtLeast).mockReturnValueOnce(true);
    const onOpenVoiceChat = vi.fn();
    const options = threadHeaderRight({
      botId: "bot-1",
      inGroup: false,
      readOnly: false,
      t,
      color: "#000",
      onGroupSettings: () => undefined,
      onOpenVoiceChat,
    });
    const renderItems = options.unstable_headerRightItems as unknown as (() => unknown) | undefined;
    const items = renderItems?.() as
      | Array<{
          label: string;
          icon?: { name?: string };
          onPress?: unknown;
        }>
      | undefined;
    const phone = items?.find((item) => item.icon?.name === "phone");
    expect(phone?.label).toBe("Voice chat");
    expect(phone?.onPress).toBe(onOpenVoiceChat);
  });

  it("shows no phone button in a group or a read-only chat", () => {
    const group = threadHeaderRight({
      inGroup: true,
      readOnly: false,
      t,
      color: "#000",
      onGroupSettings: () => undefined,
      onOpenVoiceChat: () => undefined,
    });
    expect(
      headerButtons(group).some((button) => button.props.accessibilityLabel === "Voice chat"),
    ).toBe(false);

    const readOnly = threadHeaderRight({
      botId: "bot-1",
      inGroup: false,
      readOnly: true,
      t,
      color: "#000",
      onGroupSettings: () => undefined,
      onOpenVoiceChat: () => undefined,
    });
    expect(readOnly.headerRight).toBeUndefined();
  });
});
