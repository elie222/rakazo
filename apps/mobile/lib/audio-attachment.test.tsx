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
vi.mock("../lib/appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("../lib/i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("../lib/artifact-open", () => ({
  audioArtifactUri: vi.fn(),
  openMobileArtifact: mocks.share,
}));
vi.mock("../lib/attachment-audio", () => ({
  INITIAL_ATTACHMENT_AUDIO_STATE: { playing: false, loading: false, duration: 0, currentTime: 0 },
  createAttachmentAudioPlayer: () => ({ toggle: mocks.toggle, dispose: mocks.dispose }),
}));
vi.mock("../components/glass-icon-button", () => ({
  GlassIconButton: ({
    accessibilityLabel,
    onPress,
  }: {
    accessibilityLabel: string;
    onPress: () => void;
  }) =>
    createElement("button", { type: "button", "aria-label": accessibilityLabel, onClick: onPress }),
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
