// @vitest-environment jsdom

import { deferred } from "@rakazo/core/test-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const rpcMock = vi.hoisted(() => ({
  trustedLinkSites: { list: vi.fn(), trust: vi.fn(), remove: vi.fn() },
  scope: vi.fn(),
}));
vi.mock("../../lib/query/rpc", () => ({
  rpc: rpcMock,
  rpcForSpace: (spaceId: string) => {
    rpcMock.scope(spaceId);
    throw new Error("Space unavailable");
  },
  createSpaceRpc: (spaceId: string | null) => {
    rpcMock.scope(spaceId);
    return rpcMock;
  },
  selectedSpaceId: () => "unavailable-space",
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    String.raw({ raw: parts }, ...values);
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
}));

import { QueryUserProvider } from "../../lib/query/query";
import { TrustedLinkSitesSettings } from "./TrustedLinkSitesSettings";

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
          <TrustedLinkSitesSettings />
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

it("lists trusted sites and removes one", async () => {
  rpcMock.trustedLinkSites.list
    .mockResolvedValueOnce(["alice.github.io", "example.com"])
    .mockResolvedValue(["alice.github.io"]);
  rpcMock.trustedLinkSites.remove.mockResolvedValue({ ok: true });
  const view = await render();
  const rows = () =>
    [...view.container.querySelectorAll("[data-testid='trusted-link-sites'] span")].map(
      (row) => row.textContent,
    );
  await vi.waitFor(() => expect(rows()).toEqual(["alice.github.io", "example.com"]));
  expect(view.container.textContent).toContain("Trusted sites");

  const removes = [...view.container.querySelectorAll("button")];
  expect(removes.map((button) => button.getAttribute("aria-label"))).toEqual([
    "Remove alice.github.io",
    "Remove example.com",
  ]);
  expect(removes.map((button) => button.textContent)).toEqual(["Remove", "Remove"]);
  const remove = removes[1];
  await act(async () => remove?.click());
  expect(rpcMock.trustedLinkSites.remove).toHaveBeenCalledWith({ site: "example.com" });
  expect(rpcMock.scope).toHaveBeenCalledWith(null);
  expect(rpcMock.scope.mock.calls.every(([spaceId]) => spaceId === null)).toBe(true);
  await vi.waitFor(() => expect(rows()).toEqual(["alice.github.io"]));
  await view.cleanup();
});

function removeButtons(container: HTMLElement) {
  return [
    ...container.querySelectorAll<HTMLButtonElement>("[data-testid='trusted-link-sites'] button"),
  ];
}

it("holds every Remove button while a removal is in flight and sends one request", async () => {
  rpcMock.trustedLinkSites.list
    .mockResolvedValueOnce(["alice.github.io", "example.com"])
    .mockResolvedValue(["alice.github.io"]);
  const answer = deferred<{ ok: boolean }>();
  rpcMock.trustedLinkSites.remove.mockReturnValue(answer.promise);
  const view = await render();
  await vi.waitFor(() => expect(removeButtons(view.container)).toHaveLength(2));

  await act(async () => removeButtons(view.container)[1]?.click());
  expect(removeButtons(view.container).map((button) => button.disabled)).toEqual([true, true]);
  await act(async () => removeButtons(view.container)[1]?.click());
  await act(async () => removeButtons(view.container)[0]?.click());
  expect(rpcMock.trustedLinkSites.remove).toHaveBeenCalledTimes(1);

  await act(async () => answer.resolve({ ok: true }));
  await vi.waitFor(() => expect(removeButtons(view.container)).toHaveLength(1));
  expect(removeButtons(view.container)[0]?.disabled).toBe(false);
  await view.cleanup();
});

it("shows the failure and brings the Remove buttons back", async () => {
  rpcMock.trustedLinkSites.list.mockResolvedValue(["example.com"]);
  rpcMock.trustedLinkSites.remove.mockRejectedValue(new Error(""));
  const view = await render();
  await vi.waitFor(() => expect(removeButtons(view.container)).toHaveLength(1));

  await act(async () => removeButtons(view.container)[0]?.click());
  await vi.waitFor(() =>
    expect(view.container.querySelector("[role='alert']")?.textContent).toBe("Could not continue"),
  );
  expect(removeButtons(view.container)[0]?.disabled).toBe(false);
  expect(view.container.textContent).toContain("example.com");
  await view.cleanup();
});

it("holds Remove until the account-wide list refresh finishes", async () => {
  const refreshed = deferred<string[]>();
  rpcMock.trustedLinkSites.list
    .mockResolvedValueOnce(["example.com", "other.test"])
    .mockReturnValue(refreshed.promise);
  rpcMock.trustedLinkSites.remove.mockResolvedValue({ ok: true });
  const view = await render();
  await vi.waitFor(() => expect(removeButtons(view.container)).toHaveLength(2));

  await act(async () => removeButtons(view.container)[0]?.click());
  await vi.waitFor(() => expect(rpcMock.trustedLinkSites.list).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(removeButtons(view.container)).toHaveLength(1));
  expect(removeButtons(view.container)[0]?.disabled).toBe(true);
  expect(view.container.textContent).not.toContain("example.com");
  await act(async () => refreshed.resolve(["other.test"]));
  await vi.waitFor(() => expect(removeButtons(view.container)[0]?.disabled).toBe(false));
  await view.cleanup();
});

it("forgets a removed site's trust even when the list refresh fails", async () => {
  rpcMock.trustedLinkSites.list
    .mockResolvedValueOnce(["example.com"])
    .mockRejectedValue(new Error("Offline"));
  rpcMock.trustedLinkSites.remove.mockResolvedValue({ ok: true });
  const view = await render();
  await vi.waitFor(() => expect(removeButtons(view.container)).toHaveLength(1));

  await act(async () => removeButtons(view.container)[0]?.click());
  await vi.waitFor(() => expect(rpcMock.trustedLinkSites.list).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(view.container.textContent).not.toContain("example.com"));
  await view.cleanup();
});

it("shows nothing while no site is trusted", async () => {
  rpcMock.trustedLinkSites.list.mockResolvedValue([]);
  const view = await render();
  await vi.waitFor(() => expect(rpcMock.trustedLinkSites.list).toHaveBeenCalled());
  expect(view.container.innerHTML).toBe("");
  await view.cleanup();
});
