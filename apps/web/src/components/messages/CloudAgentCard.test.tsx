// @vitest-environment jsdom

import type { MessageBlock } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const rpcMock = vi.hoisted(() => ({
  trustedLinkSites: { list: vi.fn(), trust: vi.fn(), remove: vi.fn() },
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
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

import { QueryUserProvider } from "../../lib/query/query";
import { CloudAgentCard } from "./CloudAgentCard";
import { MarkdownLinkPrompt } from "./markdown-link-prompt";

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const block = {
  kind: "cloud_agent",
  title: "Fix the build",
  status: "finished",
  prUrl: "https://git.example.test/org/repo/pull/7",
} as unknown as Extract<MessageBlock, { kind: "cloud_agent" }>;

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
          <MarkdownLinkPrompt>
            <CloudAgentCard block={block} />
          </MarkdownLinkPrompt>
        </QueryUserProvider>
      </QueryClientProvider>,
    );
  });
  await vi.waitFor(() => expect(rpcMock.trustedLinkSites.list).toHaveBeenCalled());
  const link = () => container.querySelector("a");
  return {
    link,
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

it("asks before opening the pull request link", async () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  rpcMock.trustedLinkSites.list.mockResolvedValue([]);
  const view = await render();
  await act(async () => view.link()?.click());
  expect(open).not.toHaveBeenCalled();
  expect(document.querySelector("[role='alertdialog']")).not.toBeNull();
  const cancel = [...document.querySelectorAll<HTMLButtonElement>("[role='alertdialog'] button")];
  await act(async () => cancel.find((button) => button.textContent === "Cancel")?.click());
  await view.cleanup();
});

it("opens a trusted site's link without asking", async () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  rpcMock.trustedLinkSites.list.mockResolvedValue(["example.test"]);
  const view = await render();
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  await act(async () => view.link()?.click());
  expect(document.querySelector("[role='alertdialog']")).toBeNull();
  expect(open).toHaveBeenCalledWith(
    "https://git.example.test/org/repo/pull/7",
    "_blank",
    "noopener,noreferrer",
  );
  await view.cleanup();
});
