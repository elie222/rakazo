// @vitest-environment jsdom
import { tokensForAppearance } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import ComposeSegmentedControl from "../components/native-segmented-control-compose";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const state = vi.hoisted(() => ({ scheme: "light" as "light" | "dark" }));
vi.mock("./native", () => ({
  useResolvedAppearance: () => state.scheme,
  useMobileTokens: () => tokensForAppearance(state.scheme),
}));
vi.mock("react-native", () => ({
  StyleSheet: { absoluteFill: { position: "absolute" } },
  ScrollView: () => {
    throw new Error("Segmented controls must not scroll");
  },
  View: ({
    children,
    importantForAccessibility,
    pointerEvents,
  }: {
    children: ReactNode;
    importantForAccessibility?: string;
    pointerEvents?: string;
  }) => (
    <div data-a11y={importantForAccessibility} data-pointer-events={pointerEvents}>
      {children}
    </div>
  ),
  Pressable: ({
    onPress,
    disabled,
    accessibilityLabel,
    accessibilityRole,
    accessibilityState,
  }: {
    onPress: () => void;
    disabled: boolean;
    accessibilityLabel: string;
    accessibilityRole: string;
    accessibilityState: { checked: boolean; selected: boolean; disabled: boolean };
  }) => (
    <input
      type="radio"
      data-accessibility-role={accessibilityRole}
      aria-label={accessibilityLabel}
      aria-checked={accessibilityState.checked && accessibilityState.selected}
      checked={accessibilityState.checked && accessibilityState.selected}
      readOnly
      disabled={disabled}
      onClick={onPress}
    />
  ),
}));
vi.mock("@expo/ui/jetpack-compose", () => ({
  Host: ({ children, ...props }: { children: ReactNode }) => (
    <div data-host={JSON.stringify(props)}>{children}</div>
  ),
  SingleChoiceSegmentedButtonRow: ({ children, ...props }: { children: ReactNode }) => (
    <div data-row={JSON.stringify(props)}>{children}</div>
  ),
  SegmentedButton: Object.assign(
    ({ children, onClick, ...props }: { children: ReactNode; onClick: () => void }) => (
      <button type="button" data-segment={JSON.stringify(props)} onClick={onClick}>
        {children}
      </button>
    ),
    { Label: ({ children }: { children: ReactNode }) => <div>{children}</div> },
  ),
  Text: ({ children, ...props }: { children: ReactNode }) => (
    <span data-text={JSON.stringify(props)}>{children}</span>
  ),
}));
vi.mock("@expo/ui/jetpack-compose/modifiers", () => ({
  alpha: (value: number) => ({ alpha: value }),
  height: (value: number) => ({ height: value }),
  fillMaxWidth: () => ({ fillMaxWidth: true }),
  weight: (value: number) => ({ weight: value }),
}));

const options = [
  { value: "direct", label: "Direct MCP" },
  { value: "composio", label: "Composio" },
  { value: "pipedream", label: "Pipedream" },
];
const onChange = vi.fn();
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
async function render(value: string | undefined, disabled = false, choices = options) {
  if (!root) {
    container = document.createElement("div");
    root = createRoot(container);
  }
  await act(async () =>
    root.render(
      <ComposeSegmentedControl
        accessibilityLabel="Server integrations"
        value={value}
        onChange={onChange}
        options={choices}
        disabled={disabled}
      />,
    ),
  );
}
afterEach(async () => {
  await act(async () => root.unmount());
  root = undefined as unknown as ReturnType<typeof createRoot>;
  onChange.mockClear();
});
function props(selector: string) {
  return Array.from(container.querySelectorAll(`[data-${selector}]`), (element) =>
    JSON.parse(element.getAttribute(`data-${selector}`) ?? "null"),
  );
}
it.each([
  { scheme: "light", disabled: false },
  { scheme: "light", disabled: true },
  { scheme: "dark", disabled: false },
  { scheme: "dark", disabled: true },
] as const)("uses neutral $scheme tokens with disabled=$disabled", async ({ scheme, disabled }) => {
  state.scheme = scheme;
  await render("composio", disabled);
  const tokens = tokensForAppearance(scheme);
  const fill = scheme === "light" ? tokens.accent : tokens.chatUser;
  expect(props("host")[0]).toMatchObject({
    colorScheme: scheme,
    seedColor: tokens.foreground,
    style: { height: 40 },
  });
  expect(props("segment")[1]).toMatchObject({
    selected: true,
    enabled: !disabled,
    colors: {
      activeContainerColor: fill,
      inactiveContainerColor: "transparent",
      activeContentColor: tokens.foreground,
      inactiveContentColor: tokens.mutedForeground,
      activeBorderColor: tokens.border,
      inactiveBorderColor: tokens.border,
      disabledActiveContainerColor: fill,
      disabledInactiveContainerColor: "transparent",
      disabledActiveContentColor: tokens.foreground,
      disabledInactiveContentColor: tokens.mutedForeground,
      disabledActiveBorderColor: tokens.border,
      disabledInactiveBorderColor: tokens.border,
    },
  });
});
it("stays controlled when the parent ignores a press and follows later parent changes", async () => {
  await render("direct");
  await act(async () => container.querySelectorAll<HTMLElement>('input[type="radio"]')[1]?.click());
  expect(onChange).toHaveBeenCalledExactlyOnceWith("composio");
  expect(props("segment").map((item) => item.selected)).toEqual([true, false, false]);
  await render("pipedream");
  expect(props("segment").map((item) => item.selected)).toEqual([false, false, true]);
});
it.each([undefined, "unmatched"])("keeps every segment unselected for %s", async (value) => {
  await render(value);
  expect(props("segment").every((item) => !item.selected)).toBe(true);
  expect(
    Array.from(container.querySelectorAll('input[type="radio"]'), (button) =>
      button.getAttribute("aria-checked"),
    ),
  ).toEqual(["false", "false", "false"]);
});
it("dims and disables every segment, including the native callback", async () => {
  await render("direct", true);
  expect(props("segment").every((item) => !item.enabled)).toBe(true);
  expect(props("row")[0].modifiers).toContainEqual({ alpha: 0.38 });
  await act(async () => {
    container.querySelectorAll<HTMLElement>('input[type="radio"]')[1]?.click();
    container.querySelectorAll<HTMLElement>("[data-segment]")[1]?.click();
  });
  expect(onChange).not.toHaveBeenCalled();
});
it("owns one radio per segment with group, label and selected state; hides native descendants", async () => {
  await render("direct");
  const radios = container.querySelectorAll('input[type="radio"]');
  expect(radios).toHaveLength(3);
  expect(radios[0]?.getAttribute("aria-label")).toBe("Server integrations, Direct MCP");
  expect(radios[0]?.getAttribute("aria-checked")).toBe("true");
  expect(
    container.querySelector(
      '[data-a11y="no-hide-descendants"][data-pointer-events="none"] [data-host]',
    ),
  ).not.toBeNull();
});
it.each([
  {
    choices: [
      { value: "system", label: "System" },
      { value: "light", label: "Light" },
      { value: "dark", label: "Dark" },
    ],
  },
  {
    choices: [
      { value: "team", label: "Team" },
      { value: "private", label: "Private" },
    ],
  },
])(
  "preserves caller labels at 14sp on one line with equal shares of the full width",
  async ({ choices }) => {
    await render(undefined, false, choices);
    expect(Array.from(container.querySelectorAll("span"), (text) => text.textContent)).toEqual(
      choices.map((option) => option.label),
    );
    expect(
      props("text").every(
        (item) =>
          item.maxLines === 1 &&
          !item.softWrap &&
          item.overflow === "clip" &&
          item.style.fontSize === 14,
      ),
    ).toBe(true);
    expect(props("host")[0].matchContents).toBeUndefined();
    expect(props("row")[0].modifiers).toContainEqual({ fillMaxWidth: true });
    expect(
      props("segment").every((item) =>
        item.modifiers.some((modifier: { weight?: number }) => modifier.weight === 1),
      ),
    ).toBe(true);
    expect(props("row")[0].modifiers).toContainEqual({ height: 40 });
  },
);
