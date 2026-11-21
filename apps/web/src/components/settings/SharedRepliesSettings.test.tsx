// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const rpcMock = vi.hoisted(() => ({
  replyShares: { list: vi.fn(), create: vi.fn(), remove: vi.fn() },
}));
vi.mock("../../lib/query/rpc", () => ({
  rpc: rpcMock,
  rpcForSpace: () => rpcMock,
  createSpaceRpc: () => rpcMock,
  selectedSpaceId: () => null,
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    String.raw({ raw: parts }, ...values);
  return {
    useLingui: () => ({ t, i18n: { locale: "en-US" } }),
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
}));

import { QueryUserProvider } from "../../lib/query/query";
import { SharedRepliesSettings } from "./SharedRepliesSettings";

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

async function render() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <QueryUserProvider value="user-1">
          <SharedRepliesSettings />
        </QueryUserProvider>
      </QueryClientProvider>,
    );
  });
  return {
    container,
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const share = (id: string, botName: string, preview: string) => ({
  id,
  botName,
  preview,
  createdAt: "2026-11-02T10:00:00.000Z",
});

it("lists every shared reply with its bot, first words and date, and removes one", async () => {
  rpcMock.replyShares.list
    .mockResolvedValueOnce([share("s1", "Scout", "The answer is 42."), share("s2", "Ada", "Hi")])
    .mockResolvedValue([share("s1", "Scout", "The answer is 42.")]);
  rpcMock.replyShares.remove.mockResolvedValue({ ok: true });
  const view = await render();
  const section = () => view.container.querySelector("[data-testid='shared-replies']");
  await vi.waitFor(() => expect(section()?.textContent).toContain("Shared links"));
  expect(section()?.textContent).toContain("Scout");
  expect(section()?.textContent).toContain("The answer is 42.");
  expect(
    [...(section()?.querySelectorAll("time") ?? [])].map((time) => [
      time.textContent,
      time.getAttribute("dateTime"),
    ]),
  ).toEqual([
    ["Nov 2, 2026", "2026-11-02T10:00:00.000Z"],
    ["Nov 2, 2026", "2026-11-02T10:00:00.000Z"],
  ]);

  const removes = [...view.container.querySelectorAll("button")];
  expect(removes.map((button) => button.getAttribute("aria-label"))).toEqual([
    "Remove link to Scout's reply",
    "Remove link to Ada's reply",
  ]);
  await act(async () => removes[1]?.click());
  expect(rpcMock.replyShares.remove).toHaveBeenCalledWith({ shareId: "s2" });
  await vi.waitFor(() => expect(view.container.querySelectorAll("button")).toHaveLength(1));
  await view.cleanup();
});

it("shows the failure when a link could not be removed", async () => {
  rpcMock.replyShares.list.mockResolvedValue([share("s1", "Scout", "Hello")]);
  rpcMock.replyShares.remove.mockRejectedValue(new Error("offline"));
  const view = await render();
  await vi.waitFor(() => expect(view.container.querySelector("button")).not.toBeNull());
  await act(async () => view.container.querySelector("button")?.click());
  await vi.waitFor(() => expect(view.container.querySelector("[role='alert']")).not.toBeNull());
  await view.cleanup();
});

it("shows nothing while no reply is shared", async () => {
  rpcMock.replyShares.list.mockResolvedValue([]);
  const view = await render();
  await vi.waitFor(() => expect(rpcMock.replyShares.list).toHaveBeenCalled());
  expect(view.container.innerHTML).toBe("");
  await view.cleanup();
});
