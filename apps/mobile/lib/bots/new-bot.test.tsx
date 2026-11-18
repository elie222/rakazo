// @vitest-environment jsdom

import type { Deferred } from "@rakazo/core/test-async";
import { deferred } from "@rakazo/core/test-async";
import { notifyManager } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import NewBot from "../../app/new-bot";
import type { SaveSend } from "../query/query";
import { queryClient } from "../query/query";

const { rpc, router, params, selected, header, createInboxBot, askForModelBeforeFirstBot } =
  vi.hoisted(() => ({
    rpc: vi.fn(),
    selected: { spaceId: "space-1" },
    router: { back: vi.fn(), dismiss: vi.fn(), push: vi.fn() },
    params: { current: {} as { spaceId?: string } },
    header: { cancel: (): void => undefined },
    createInboxBot: vi.fn(),
    askForModelBeforeFirstBot: vi.fn(),
  }));
vi.mock("../layout/side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("../api/api", () => ({
  rpc,
  currentApiBase: () => "http://api.test",
  selectedSpaceId: () => selected.spaceId,
  captureApiRequestContext: async (spaceId: string | null = selected.spaceId) => ({
    apiBase: "http://api.test",
    sessionGeneration: 1,
    headers: spaceId ? { "x-rakazo-space-id": spaceId } : {},
  }),
}));
vi.mock("../api/session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("../platform/app-foreground", () => ({ useAppForeground: () => true }));
vi.mock("../inbox/inbox-changes", () => ({ openChatFromInbox: () => false }));
vi.mock("../inbox/create-inbox-bot", () => ({ createInboxBot, askForModelBeforeFirstBot }));
vi.mock("../native/native", () => ({ native: {}, useMobileTokens: () => ({}) }));
vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useFocusEffect: () => undefined,
  useLocalSearchParams: () => params.current,
  useRouter: () => router,
}));
vi.mock("react-native", () => {
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
    View,
    ScrollView: View,
    Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    TextInput: ({
      value,
      onChangeText,
      editable,
    }: {
      value: string;
      onChangeText: (value: string) => void;
      editable?: boolean;
    }) => (
      <input
        value={value}
        disabled={editable === false}
        onChange={(event) => onChangeText(event.target.value)}
      />
    ),
  };
});
vi.mock("../../components/bots/bot-avatar", () => ({ BotAvatar: () => null }));
vi.mock("../../components/bots/bot-look-picker", () => ({ BotLookPicker: () => null }));
vi.mock("../../components/native/sheet-header", () => ({
  cancelHeaderOptions: (_label: string, cancel: () => void) => {
    header.cancel = cancel;
    return {};
  },
}));
vi.mock("../../components/native/native-action-button", () => ({
  NativeActionButton: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onPress} disabled={disabled}>
      {label}
    </button>
  ),
}));
// Cache updates reach the screen inside act instead of on a later timer.
notifyManager.setScheduler((callback) => callback());

let root: Root;
let container: HTMLDivElement;
let creating: Deferred<string>;
beforeEach(() => {
  vi.clearAllMocks();
  queryClient.clear();
  params.current = {};
  selected.spaceId = "space-1";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
  rpc.mockResolvedValue({ botAvatarSet: "organic" });
  askForModelBeforeFirstBot.mockResolvedValue(false);
  creating = deferred<string>();
  createInboxBot.mockImplementation(() => creating.promise);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function button(label: string) {
  return [...container.querySelectorAll("button")].find((item) => item.textContent === label);
}
async function start() {
  await act(async () => root.render(<NewBot />));
  await act(async () => {
    const input = container.querySelector("input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Scout");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("creates once on a double tap, through the save's send, and holds the form meanwhile", async () => {
  params.current = { spaceId: "space-work" };
  await start();
  await act(async () => {
    button("Create")!.click();
    button("Create")!.click();
  });
  expect(createInboxBot).toHaveBeenCalledOnce();
  const [{ input, send, spaceId }] = createInboxBot.mock.calls[0] as [
    { input: { name: string }; send: SaveSend; spaceId?: string },
  ];
  expect(input.name).toBe("Scout");
  expect(spaceId).toBe("space-work");
  expect(button("Creating…")?.disabled).toBe(true);
  expect(container.querySelector("input")!.disabled).toBe(true);
  // The bot's requests go to the Space the screen was opened for.
  rpc.mockClear().mockResolvedValue([]);
  await send("bots/list", undefined);
  expect(rpc).toHaveBeenCalledWith("bots/list", undefined, {
    requestContext: expect.objectContaining({ headers: { "x-rakazo-space-id": "space-work" } }),
  });
  await act(async () => creating.resolve("created"));
  expect(router.back).not.toHaveBeenCalled();
  expect(button("Creating…")?.disabled).toBe(true);
});

it("names the Space it creates in, so the chat and model check use it too", async () => {
  await start();
  expect(askForModelBeforeFirstBot).toHaveBeenCalledWith("space-1", expect.any(Function));
  await act(async () => button("Create")!.click());
  const [{ spaceId }] = createInboxBot.mock.calls[0] as [{ spaceId?: string }];
  expect(spaceId).toBe("space-1");
});

it("keeps sending the new bot's onboarding to its Space after another is selected", async () => {
  await start();
  await act(async () => button("Create")!.click());
  const [{ send }] = createInboxBot.mock.calls[0] as [{ send: SaveSend }];
  selected.spaceId = "space-2";
  rpc.mockClear().mockResolvedValue({});
  await send("onboarding/start", { botId: "bot-1" });
  expect(rpc).toHaveBeenCalledWith(
    "onboarding/start",
    { botId: "bot-1" },
    {
      requestContext: expect.objectContaining({ headers: { "x-rakazo-space-id": "space-1" } }),
    },
  );
});

it("shows the failure and offers Create again", async () => {
  await start();
  await act(async () => button("Create")!.click());
  await act(async () => creating.reject(new Error("Name taken")));
  expect(container.textContent).toContain("Name taken");
  expect(button("Create")?.disabled).toBe(false);
});

it.each(["needsModel", "stale"])(
  "closes when there is nothing left to do (%s)",
  async (outcome) => {
    await start();
    await act(async () => button("Create")!.click());
    await act(async () => creating.resolve(outcome));
    expect(router.back).toHaveBeenCalledOnce();
  },
);

it("creates nothing while the opening check asks for a model", async () => {
  askForModelBeforeFirstBot.mockResolvedValue(true);
  await start();
  expect(router.back).toHaveBeenCalledOnce();
  await act(async () => button("Create")?.click());
  expect(createInboxBot).not.toHaveBeenCalled();
});

it("ignores Cancel from the Create tap on, before the screen shows it", async () => {
  await start();
  const cancelAsRendered = header.cancel;
  await act(async () => {
    button("Create")!.click();
    cancelAsRendered();
  });
  expect(createInboxBot).toHaveBeenCalledOnce();
  expect(router.back).not.toHaveBeenCalled();
});

it("lets Cancel close the screen after a create fails once another Space is selected", async () => {
  await start();
  await act(async () => button("Create")!.click());
  selected.spaceId = "space-2";
  await act(async () => root.render(<NewBot />));
  await act(async () => creating.reject(new Error("Name taken")));
  expect(button("Create")?.disabled).toBe(false);
  header.cancel();
  expect(router.back).toHaveBeenCalledOnce();
});

it("closes when the Space changed during the create", async () => {
  await start();
  await act(async () => button("Create")!.click());
  selected.spaceId = "space-2";
  await act(async () => root.render(<NewBot />));
  await act(async () => creating.resolve("stale"));
  expect(router.back).toHaveBeenCalledOnce();
});
