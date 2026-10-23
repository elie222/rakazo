// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const messaging = vi.hoisted(() => ({
  status: vi.fn(),
  channels: { list: vi.fn(async () => []), respond: vi.fn(), leave: vi.fn() },
  connections: { list: vi.fn(async () => []), respond: vi.fn(), revoke: vi.fn() },
  identities: { unlink: vi.fn() },
  link: {
    start: vi.fn(async () => ({
      code: "ABCD-2345",
      expiresAt: new Date(Date.now() + 20_000).toISOString(),
    })),
  },
}));

vi.mock("../lib/rpc", () => ({
  rpc: {
    messaging,
    bots: { list: vi.fn(async () => [{ id: "bot-1", name: "Chief" }]) },
    spaces: { list: vi.fn(async () => ({ current: { externalConversations: [] } })) },
  },
}));
vi.mock("./ExternalConversationSettings", () => ({ ExternalConversationSettings: () => null }));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce(
      (text, part, index) => `${text}${index > 0 ? String(values[index - 1]) : ""}${part}`,
      "",
    );
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children?: ReactNode }) => children,
  };
});
vi.mock("@rakazo/ui-web", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: ({
      children,
      onClick,
      disabled,
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
      <button type="button" disabled={disabled} onClick={onClick}>
        {children}
      </button>
    ),
    Dialog: Pass,
    DialogClose: Pass,
    DialogContent: Pass,
    DialogTitle: Pass,
    NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
    NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  };
});

import { MessagingSettingsOverlay } from "./MessagingSettingsOverlay";

const identity = {
  id: "mi-1",
  provider: "telegram",
  address: "424242",
  botId: "bot-1",
  botName: "Chief",
};

function statusWith(identities: (typeof identity)[]) {
  return { enabled: true, providers: ["telegram"], openSignup: false, identities };
}

function pendingStatus() {
  let resolve!: (status: ReturnType<typeof statusWith>) => void;
  const promise = new Promise<ReturnType<typeof statusWith>>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.clearAllMocks();
  messaging.status.mockReset();
  messaging.channels.list.mockReset();
  messaging.channels.list.mockResolvedValue([]);
});

async function startLink() {
  await act(async () => root.render(<MessagingSettingsOverlay onClose={() => undefined} />));
  const select = container.querySelector("select");
  if (!select) throw new Error("Missing bot select");
  await act(async () => {
    select.value = "bot-1";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const link = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Link a chat app"),
  );
  await act(async () => link?.click());
  expect(container.querySelector('[data-testid="messaging-link-code"]')).not.toBeNull();
}

it("lists a chat app linked from the chat app without reopening the dialog", async () => {
  messaging.status.mockResolvedValue(statusWith([]));
  await startLink();
  expect(container.textContent).toContain("No chat apps linked yet.");

  // The code is sent from the chat app; the server now reports the identity.
  messaging.status.mockResolvedValue(statusWith([identity]));
  await act(async () => vi.advanceTimersByTimeAsync(3_000));

  expect(container.textContent).toContain("424242");
  expect(container.querySelector('[data-testid="messaging-link-code"]')).toBeNull();
});

it("stops polling once the link code expires", async () => {
  messaging.status.mockResolvedValue(statusWith([]));
  await startLink();
  await act(async () => vi.advanceTimersByTimeAsync(20_000));
  expect(container.querySelector('[data-testid="messaging-link-code"]')).toBeNull();
  const calls = messaging.status.mock.calls.length;

  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(messaging.status.mock.calls.length).toBe(calls);
});

it.each([
  [403, 1],
  [404, 1],
  [503, 4],
])("after a %i status poll, link polls total %i", async (status, polls) => {
  messaging.status.mockResolvedValue(statusWith([]));
  await startLink();
  const calls = messaging.status.mock.calls.length;
  messaging.status.mockRejectedValueOnce(Object.assign(new Error("Refused"), { status }));
  await act(async () => vi.advanceTimersByTimeAsync(12_000));
  expect(messaging.status).toHaveBeenCalledTimes(calls + polls);
});

it("detects a same-address relink to the selected bot", async () => {
  messaging.status.mockResolvedValue(
    statusWith([{ ...identity, botId: "bot-2", botName: "Other" }]),
  );
  await startLink();
  expect(container.textContent).toContain("→ Other");

  messaging.status.mockResolvedValue(statusWith([identity]));
  await act(async () => vi.advanceTimersByTimeAsync(3_000));

  expect(container.textContent).toContain("→ Chief");
  expect(container.textContent).not.toContain("→ Other");
  expect(container.querySelector('[data-testid="messaging-link-code"]')).toBeNull();
});

it("ignores links to a different bot", async () => {
  messaging.status.mockResolvedValue(statusWith([]));
  await startLink();
  messaging.status.mockResolvedValue(statusWith([{ ...identity, botId: "bot-2" }]));
  await act(async () => vi.advanceTimersByTimeAsync(3_000));
  expect(container.querySelector('[data-testid="messaging-link-code"]')).not.toBeNull();
});

it("keeps the detected identity when refreshing other lists fails", async () => {
  messaging.status.mockResolvedValue(statusWith([]));
  await startLink();
  messaging.status.mockResolvedValue(statusWith([identity]));
  messaging.channels.list.mockRejectedValueOnce(new Error("Unavailable"));
  await act(async () => vi.advanceTimersByTimeAsync(3_000));

  expect(container.textContent).toContain("424242");
  expect(container.querySelector('[data-testid="messaging-link-code"]')).toBeNull();
  const calls = messaging.status.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(3_000));
  expect(messaging.status).toHaveBeenCalledTimes(calls);
});

it("waits for a pending poll to settle before scheduling another", async () => {
  messaging.status.mockResolvedValue(statusWith([]));
  await startLink();
  const pending = pendingStatus();
  messaging.status.mockReturnValueOnce(pending.promise);
  const calls = messaging.status.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(9_000));
  expect(messaging.status).toHaveBeenCalledTimes(calls + 1);

  await act(async () => pending.resolve(statusWith([])));
  await act(async () => vi.advanceTimersByTimeAsync(2_999));
  expect(messaging.status).toHaveBeenCalledTimes(calls + 1);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(messaging.status).toHaveBeenCalledTimes(calls + 2);
});

it("ignores a previous code's pending response after issuing a new code", async () => {
  messaging.status.mockResolvedValue(statusWith([]));
  await startLink();
  const pending = pendingStatus();
  messaging.status.mockReturnValueOnce(pending.promise);
  await act(async () => vi.advanceTimersByTimeAsync(3_000));
  const link = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Link a chat app"),
  );
  await act(async () => link?.click());
  const calls = messaging.status.mock.calls.length;
  await act(async () => pending.resolve(statusWith([identity])));

  expect(container.querySelector('[data-testid="messaging-link-code"]')).not.toBeNull();
  expect(container.textContent).not.toContain("424242");
  expect(messaging.status).toHaveBeenCalledTimes(calls);
});

it("ignores a pending response after expiry", async () => {
  messaging.status.mockResolvedValue(statusWith([]));
  await startLink();
  const pending = pendingStatus();
  messaging.status.mockReturnValueOnce(pending.promise);
  await act(async () => vi.advanceTimersByTimeAsync(20_000));
  const calls = messaging.status.mock.calls.length;
  await act(async () => pending.resolve(statusWith([identity])));
  await act(async () => vi.advanceTimersByTimeAsync(3_000));

  expect(container.querySelector('[data-testid="messaging-link-code"]')).toBeNull();
  expect(container.textContent).not.toContain("424242");
  expect(messaging.status).toHaveBeenCalledTimes(calls);
});
