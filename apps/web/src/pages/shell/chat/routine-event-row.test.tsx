// @vitest-environment jsdom
import { deferred } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { createSpaceRpc } from "../../../lib/query/rpc";
import { RoutineEventRow } from "./routine-event-row";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
  }),
}));

const identity = vi.hoisted(() => ({ cancel: vi.fn(), confirm: vi.fn(async () => true) }));
// The real retry rule from contracts, with the dialog replaced by `identity.confirm`.
vi.mock("../../../components/account/ConfirmIdentityDialog", async () => {
  const { runWithIdentityConfirmation } = await import("@rakazo/contracts");
  return {
    useIdentityConfirmation: () => ({
      withIdentityConfirmation: <T,>(action: () => Promise<T>) =>
        runWithIdentityConfirmation(action, identity.confirm),
      cancel: identity.cancel,
      identityDialog: null,
    }),
  };
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it.each([
  ["created", 'Created routine "Morning joke"'],
  ["updated", 'Updated routine "Morning joke"'],
  ["enabled", 'Enabled routine "Morning joke"'],
  ["disabled", 'Disabled routine "Morning joke"'],
  ["deleted", 'Deleted routine "Morning joke"'],
] as const)("says what happened for %s", (change, expected) => {
  act(() =>
    root.render(
      <RoutineEventRow block={{ kind: "routine_event", change, name: "Morning joke" }} />,
    ),
  );
  expect(container.textContent).toBe(expected);
});

const reveal = vi.fn();
const rpc = { bots: { revealWebhookSecret: reveal } } as unknown as ReturnType<
  typeof createSpaceRpc
>;
const button = (name: string) =>
  container.querySelector<HTMLButtonElement>(`[aria-label="${name}"]`);

function renderWebhookRow(webhook = true) {
  act(() =>
    root.render(
      <RoutineEventRow
        block={{
          kind: "routine_event",
          change: "created",
          name: "Deploy hook",
          ...(webhook ? { webhook: true as const } : {}),
        }}
        botId="bot-1"
        rpc={rpc}
      />,
    ),
  );
}

it("offers no key for a routine no webhook starts", () => {
  renderWebhookRow(false);
  expect(button("Show webhook key")).toBeNull();
});

it("reads the key back for the bot and hides it again when closed", async () => {
  reveal.mockReset().mockResolvedValue({ secret: "key-123" });
  renderWebhookRow();
  await act(async () => button("Show webhook key")!.click());
  expect(reveal).toHaveBeenCalledWith({ botId: "bot-1" });
  expect(container.textContent).toContain("/api/v1/bots/bot-1/webhook");
  expect(container.textContent).toContain("Authorization: Bearer key-123");
  await act(async () => button("Hide webhook key")!.click());
  expect(identity.cancel).toHaveBeenCalled();
  expect(container.textContent).not.toContain("key-123");
  expect(container.textContent).not.toContain("/api/v1/bots/bot-1/webhook");
});

it("never shows a key that arrives after the row was closed", async () => {
  const stale = deferred<{ secret: string }>();
  const fresh = deferred<{ secret: string }>();
  reveal.mockReset().mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);
  renderWebhookRow();
  await act(async () => button("Show webhook key")!.click());
  await act(async () => button("Hide webhook key")!.click());
  await act(async () => button("Show webhook key")!.click());
  await act(async () => stale.resolve({ secret: "late-key" }));
  expect(container.textContent).not.toContain("late-key");
  await act(async () => fresh.resolve({ secret: "fresh-key" }));
  expect(container.textContent).toContain("Authorization: Bearer fresh-key");
});

it("tells another member only the creator can see the key", async () => {
  reveal
    .mockReset()
    .mockRejectedValue(Object.assign(new Error("Forbidden"), { code: "FORBIDDEN" }));
  renderWebhookRow();
  await act(async () => button("Show webhook key")!.click());
  expect(container.textContent).toContain("Only the bot's creator can see its webhook key.");
});

it("never asks a closed row's reveal to confirm it's the person", async () => {
  const pending = deferred<{ secret: string }>();
  reveal.mockReset().mockReturnValueOnce(pending.promise);
  identity.confirm.mockClear();
  renderWebhookRow();
  await act(async () => button("Show webhook key")!.click());
  await act(async () => button("Hide webhook key")!.click());
  await act(async () =>
    pending.reject(Object.assign(new Error("Confirm"), { code: "IDENTITY_CONFIRMATION_REQUIRED" })),
  );
  expect(identity.confirm).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("starts one reveal however many times the key is asked for while it runs", async () => {
  const pending = deferred<{ secret: string }>();
  reveal.mockReset().mockReturnValue(pending.promise);
  renderWebhookRow();
  await act(async () => button("Show webhook key")!.click());
  await act(async () => button("Show key")!.click());
  await act(async () => button("Show key")!.click());
  expect(reveal).toHaveBeenCalledOnce();
  await act(async () => pending.resolve({ secret: "key-123" }));
  expect(container.textContent).toContain("Authorization: Bearer key-123");
});
