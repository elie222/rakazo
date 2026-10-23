// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  begin: vi.fn(async () => ({ connectionId: "connection", authorizationUrl: null })),
  complete: vi.fn(async () => ({ status: "connected" })),
  mark: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../../lib/rpc", () => ({
  rpc: {
    connections: { begin: calls.begin, complete: calls.complete },
    onboarding: { appConnected: calls.mark },
  },
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + (index ? values[index - 1] : "") + part, ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import { AppConnectCard } from "./message-cards";

it("authorizes a card in a normal chat and marks its thread connected", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <AppConnectCard
          botId="bot"
          threadId="normal-chat"
          block={{
            kind: "app_connect",
            connectorId: "fake",
            provider: "gmail",
            name: "Gmail",
            description: "",
            logo: null,
            status: "pending",
          }}
        />,
      ),
    );
    expect(host.querySelector("button")?.textContent).toBe("Authorize");
    await act(async () => host.querySelector("button")?.click());
    expect(calls.mark).toHaveBeenCalledWith({
      botId: "bot",
      threadId: "normal-chat",
      connectorId: "fake",
      provider: "gmail",
    });
    expect(host.textContent).toContain("Connected");
    expect(host.querySelector("button")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
