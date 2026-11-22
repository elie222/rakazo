// @vitest-environment jsdom
import { deferred } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MobileBot } from "../../lib/api/mobile-types";
import { SpaceBotsModel } from "./space-bots-model";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  confirm: undefined as (() => void) | undefined,
  title: "",
}));
vi.mock("../../lib/api/api", () => ({
  rpc: mocks.rpc,
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => "space-1",
  captureApiRequestContext: async (spaceId: string | null = "space-1") => ({
    apiBase: "https://app.example.test",
    sessionGeneration: 1,
    headers: spaceId ? { "x-rakazo-space-id": spaceId } : {},
  }),
}));
vi.mock("../../lib/api/session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("../../lib/appearance/appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("../../lib/native/native", () => ({
  native: {},
  useThemedStyles: (factory: () => unknown) => factory(),
}));
vi.mock("./settings-group", () => ({
  SettingsGroup: ({ children, footer }: { children?: ReactNode; footer?: string }) => (
    <div>
      {footer}
      {children}
    </div>
  ),
  SettingsRow: ({
    title,
    onPress,
    disabled,
  }: {
    title: string;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {title}
    </button>
  ),
}));
vi.mock("react-native", () => {
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    View,
    Text: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
    StyleSheet: { create: (styles: unknown) => styles },
    Alert: {
      alert: (title: string, _body: string, buttons: { text: string; onPress?: () => void }[]) => {
        mocks.title = title;
        mocks.confirm = buttons.find((button) => button.text === "Switch")?.onPress;
      },
    },
  };
});

const bots = [
  { id: "bot-1", name: "Ada", modelProvider: "acme", modelId: "m-1" },
  { id: "bot-2", name: "Bo", modelProvider: "acme", modelId: "m-2" },
] as unknown as MobileBot[];

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("switches each bot in the named Space once, names the ones that failed, then refreshes", async () => {
  const answer = deferred<unknown>();
  mocks.rpc.mockImplementation(async (_: string, input: { botId: string }) => {
    if (input.botId === "bot-2") throw new Error("offline");
    return answer.promise;
  });
  const onSwitched = vi.fn(async () => undefined);
  await act(async () =>
    root.render(<SpaceBotsModel bots={bots} spaceId="space-2" onSwitched={onSwitched} />),
  );
  container.querySelector("button")?.click();
  await act(async () => {
    mocks.confirm?.();
    mocks.confirm?.();
  });
  expect(container.querySelector("button")?.disabled).toBe(true);
  await act(async () => answer.resolve({}));
  await vi.waitFor(() => expect(container.textContent).toContain("Could not switch Bo"));
  expect(mocks.rpc).toHaveBeenCalledTimes(2);
  for (const [, , options] of mocks.rpc.mock.calls)
    expect(options.requestContext.headers["x-rakazo-space-id"]).toBe("space-2");
  expect(container.textContent).toContain("1 bot now uses the space default.");
  expect(onSwitched).toHaveBeenCalledTimes(1);
});

it.each([
  [2, "2 bots have their own model: Bot 1, Bot 2", "Switch 2 bots to the space default?"],
  [21, "21 bots have their own model: Bot 1, Bot 2", "Switch 21 bots to the space default?"],
])(
  "uses the plural form for %i bots in the footer and the switch prompt",
  async (count, footer, prompt) => {
    const many = Array.from({ length: count }, (_, index) => ({
      ...bots[0],
      id: `bot-${index + 1}`,
      name: `Bot ${index + 1}`,
    })) as unknown as MobileBot[];
    await act(async () => root.render(<SpaceBotsModel bots={many} onSwitched={vi.fn()} />));
    expect(container.textContent).toContain(footer);
    container.querySelector("button")?.click();
    expect(mocks.title).toBe(prompt);
  },
);
