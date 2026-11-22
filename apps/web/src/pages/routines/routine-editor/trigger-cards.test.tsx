// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: String.raw }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../../lib/auth/auth", () => ({ authClient: { useSession: () => ({}) } }));
vi.mock("../../../lib/query/rpc", () => ({
  rpc: {},
  createSpaceRpc: () => ({}),
  rpcForSpace: () => ({}),
  selectedSpaceId: () => null,
}));

import { EmailTriggerCard } from "./trigger-cards";

it("copies a Routine's email address without opening a manual-copy dialog on denial", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient();
  try {
    const address = "scout@bots.test";
    const writeText = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("Clipboard denied", "NotAllowedError"))
      .mockResolvedValueOnce(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const copyBySelection = vi.fn(() => false);
    document.execCommand = copyBySelection;

    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <EmailTriggerCard
            bot={{ id: "bot-1", name: "Scout" }}
            domain="bots.test"
            address={address}
            senders="owner"
            onChange={vi.fn()}
            onRemove={vi.fn()}
          />
        </QueryClientProvider>,
      );
    });
    const button = container.querySelector<HTMLButtonElement>(
      `button[aria-label="Copy ${address}"]`,
    )!;
    await act(async () => button.click());
    expect(writeText).toHaveBeenCalledWith(address);
    expect(copyBySelection).toHaveBeenCalledWith("copy");
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => button.click());
    expect(button.getAttribute("aria-label")).toBe("Copied");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    Reflect.deleteProperty(navigator, "clipboard");
    Reflect.deleteProperty(document, "execCommand");
    vi.unstubAllGlobals();
  }
});
