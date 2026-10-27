// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import TeamConversationSettings from "../app/(settings)/team-conversation";
import { rpc } from "./api";

const back = vi.fn();
vi.mock("./api", () => ({ rpc: vi.fn() }));
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./native", () => ({
  native: {},
  useMobileTokens: () => ({}),
  useThemedStyles: (factory: () => unknown) => factory(),
}));
vi.mock("./user-error", () => ({
  errorText: (_: unknown, fallback = "Something went wrong. Try again.") => fallback,
}));
vi.mock("./i18n", () => ({
  useI18n: () => ({
    t: (message: string, values: Record<string, string> = {}) =>
      message.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? ""),
  }),
}));
vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ conversationId: "room-1" }),
  useRouter: () => ({ back }),
}));
vi.mock("../components/glass-title", () => ({ glassHeaderOptions: () => ({}) }));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../components/native-segmented-control", () => ({
  NativeSegmentedControl: ({
    options,
    onChange,
  }: {
    options: { value: string; label: string }[];
    onChange: (value: string) => void;
  }) => (
    <>
      {options.map((option) => (
        <button key={option.value} type="button" onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </>
  ),
}));
vi.mock("../components/settings-group", () => ({
  SettingsGroup: ({ children, footer }: { children?: ReactNode; footer?: string }) => (
    <section>
      {children}
      {footer}
    </section>
  ),
  SettingsRow: ({ title, trailing }: { title: string; trailing?: ReactNode }) => (
    <div>
      {title}
      {trailing}
    </div>
  ),
}));
vi.mock("../components/menu-picker", () => ({
  MenuPickerMenu: ({
    label,
    choices,
    onChange,
  }: {
    label: string;
    choices: { key: string; label: string }[];
    onChange: (key: string) => void;
  }) => (
    <>
      {choices.map((choice) => (
        <button key={choice.key} type="button" onClick={() => onChange(choice.key)}>
          {`${label}: ${choice.label}`}
        </button>
      ))}
    </>
  ),
}));
vi.mock("react-native", () => {
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    View,
    ScrollView: View,
    Text: View,
    TextInput: ({
      accessibilityLabel,
      value,
      onChangeText,
    }: {
      accessibilityLabel?: string;
      value?: string;
      onChangeText?: (text: string) => void;
    }) => (
      <input
        aria-label={accessibilityLabel}
        value={value ?? ""}
        onChange={(event) => onChangeText?.(event.target.value)}
      />
    ),
    StyleSheet: { create: (styles: unknown) => styles },
  };
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(rpc).mockImplementation((async (path: string) => {
    if (path === "bots/list") {
      return [{ id: "bot-1", name: "Chief", teamChatAmbientEnabled: false, teamChatRules: "" }];
    }
    if (path === "spaces/list") {
      return {
        current: {
          externalConversations: [
            {
              id: "room-1",
              botId: "bot-1",
              provider: "slack",
              displayName: "#launch",
              teamChatAmbientEnabled: null,
              teamChatRules: null,
              automatedSenderPolicies: {},
              automatedSenders: [{ id: "B_GITHUB", name: "GitHub" }],
            },
          ],
        },
      };
    }
    return { ok: true };
  }) as never);
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function click(label: string) {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (!found) throw new Error(`Missing ${label}`);
  await act(async () => found.click());
}

it("saves listening and sender handling for the room, then goes back", async () => {
  await act(async () => root.render(<TeamConversationSettings />));
  expect(container.textContent).toContain("Chief will still respond to direct mentions.");

  await click("Listen");
  expect(container.textContent).not.toContain("will still respond to direct mentions.");
  await click("GitHub: Group updates");
  await click("Save");

  expect(rpc).toHaveBeenCalledWith("externalConversations/updatePolicy", {
    externalConversationId: "room-1",
    teamChatAmbientEnabled: true,
    teamChatRules: null,
    automatedSenderPolicies: { B_GITHUB: { name: "GitHub", mode: "rollup", rollupHours: 6 } },
  });
  expect(back).toHaveBeenCalled();
});

it("saves typed hours while the field still has focus", async () => {
  await act(async () => root.render(<TeamConversationSettings />));
  await click("GitHub: Group updates");
  const hours = container.querySelector<HTMLInputElement>(
    'input[aria-label="GitHub rollup hours"]',
  );
  if (!hours) throw new Error("Missing hours field");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(hours, "12");
    hours.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Save");
  expect(rpc).toHaveBeenCalledWith(
    "externalConversations/updatePolicy",
    expect.objectContaining({
      automatedSenderPolicies: { B_GITHUB: { name: "GitHub", mode: "rollup", rollupHours: 12 } },
    }),
  );
});

it("offers a retry when the room fails to load, then shows its settings", async () => {
  const load = vi.mocked(rpc).getMockImplementation()!;
  vi.mocked(rpc).mockImplementationOnce((async () => {
    throw new Error("offline");
  }) as never);
  await act(async () => root.render(<TeamConversationSettings />));
  expect(container.textContent).not.toContain("Chief default");
  expect(container.textContent).toContain("Something went wrong. Try again.");

  await click("Retry");
  expect(vi.mocked(rpc).getMockImplementation()).toBe(load);
  expect(container.textContent).toContain("Chief default");
  expect(container.textContent).not.toContain("Something went wrong. Try again.");
});
