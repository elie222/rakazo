// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  root: vi.fn(),
  text: vi.fn(),
  toggle: vi.fn(),
  share: vi.fn(),
  dispose: vi.fn(),
  icon: vi.fn(),
  setState: undefined as undefined | ((state: Record<string, unknown>) => void),
}));
vi.mock("react-native", () => ({
  Pressable: (props: { children?: ReactNode }) => {
    mocks.root(props);
    return createElement("div", null, props.children);
  },
  View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  Text: (props: { children?: ReactNode }) => {
    mocks.text(props);
    return createElement("span", null, props.children);
  },
  ActivityIndicator: () => null,
  Alert: { alert: vi.fn() },
}));
vi.mock("../lib/appearance", () => ({
  mobileTokens: () => ({
    card: "token-card",
    destructive: "token-destructive",
    foreground: "token-foreground",
    muted: "token-muted",
    mutedForeground: "token-muted-foreground",
    secondary: "token-secondary",
  }),
}));
vi.mock("../lib/i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("../lib/artifact-open", () => ({
  audioArtifactUri: vi.fn(),
  openMobileArtifact: mocks.share,
}));
vi.mock("../lib/attachment-audio", () => ({
  INITIAL_ATTACHMENT_AUDIO_STATE: { playing: false, loading: false, duration: 0, currentTime: 0 },
  createAttachmentAudioPlayer: (
    _uri: unknown,
    setState: (state: Record<string, unknown>) => void,
  ) => {
    mocks.setState = setState;
    return { toggle: mocks.toggle, dispose: mocks.dispose };
  },
}));
vi.mock("../components/glass-icon-button", () => ({
  GlassIconButton: (props: { accessibilityLabel: string; onPress: () => void; color?: string }) => {
    mocks.icon(props);
    return createElement("button", {
      type: "button",
      "aria-label": props.accessibilityLabel,
      onClick: props.onPress,
    });
  },
}));

import { AudioAttachment } from "../components/audio-attachment";

it("preserves message actions on the row and independent play/share controls", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.share.mockResolvedValue(undefined);
  const actions = {
    onLongPress: vi.fn(),
    accessibilityActions: [{ name: "copy", label: "Copy" }],
    onAccessibilityAction: vi.fn(),
  };
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <AudioAttachment
          target={{ botId: "bot-1" }}
          artifactId="audio-1"
          name="clip"
          mimeType="audio/mpeg"
          pressableProps={actions}
        />,
      ),
    );
    const row = mocks.root.mock.lastCall?.[0];
    expect(row).toMatchObject({ onLongPress: actions.onLongPress, accessible: false });
    expect(row.accessibilityActions).toBeUndefined();
    const label = mocks.text.mock.calls.find(([props]) => props.children === "clip")?.[0];
    expect(label).toMatchObject({
      accessible: true,
      accessibilityActions: actions.accessibilityActions,
      onAccessibilityAction: actions.onAccessibilityAction,
    });
    row.onLongPress();
    label.onAccessibilityAction({ nativeEvent: { actionName: "copy" } });
    expect(actions.onLongPress).toHaveBeenCalledTimes(1);
    expect(actions.onAccessibilityAction).toHaveBeenCalledTimes(1);
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Play"]')?.click(),
    );
    expect(mocks.toggle).toHaveBeenCalledTimes(1);
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Share {name}"]')?.click(),
    );
    expect(mocks.share).toHaveBeenCalledWith({ botId: "bot-1" }, "audio-1", "clip", "audio/mpeg");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
  expect(mocks.dispose).toHaveBeenCalledTimes(1);
});

it("sits on the inset fill, not the bubble's own fill, so it shows without an outline", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <AudioAttachment
          target={{ botId: "bot-1" }}
          artifactId="audio-1"
          name="clip"
          mimeType="audio/mpeg"
        />,
      ),
    );
    const style = mocks.root.mock.lastCall?.[0].style;
    expect(style.backgroundColor).toBe("token-secondary");
    expect(style).not.toHaveProperty("borderWidth");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it.each([
  ["the user's bubble", "token-user-foreground", "token-user-foreground", "token-user-foreground"],
  ["a bot message", undefined, "token-foreground", "token-muted-foreground"],
] as const)("colours the name, time and controls for %s", async (_, labelColor, name, time) => {
  // The light user bubble is near-black, so the card's dark text disappeared on it.
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.text.mockClear();
  mocks.icon.mockClear();
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <AudioAttachment
          target={{ botId: "bot-1" }}
          artifactId="audio-1"
          name="clip"
          mimeType="audio/mpeg"
          labelColor={labelColor}
        />,
      ),
    );
    const texts = mocks.text.mock.calls.map(([props]) => props);
    expect(texts.find((props) => props.children === "clip")?.style.color).toBe(name);
    expect(texts.find((props) => props.children !== "clip")?.style.color).toBe(time);
    expect(mocks.icon.mock.calls.map(([props]) => props.color)).toEqual([labelColor, labelColor]);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it.each([
  ["the user's bubble", "token-user-foreground", "token-user-foreground"],
  ["a bot message", undefined, "token-destructive"],
] as const)("shows a playback error readably on %s", async (_, labelColor, color) => {
  // The light red is 3.4:1 on the near-black inset of the user's bubble.
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.text.mockClear();
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <AudioAttachment
          target={{ botId: "bot-1" }}
          artifactId="audio-1"
          name="clip"
          mimeType="audio/mpeg"
          labelColor={labelColor}
        />,
      ),
    );
    await act(async () =>
      mocks.setState?.({
        playing: false,
        loading: false,
        duration: 0,
        currentTime: 0,
        error: true,
      }),
    );
    const alert = mocks.text.mock.calls.findLast(([props]) => props.accessibilityRole === "alert");
    expect(alert?.[0].style.color).toBe(color);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
