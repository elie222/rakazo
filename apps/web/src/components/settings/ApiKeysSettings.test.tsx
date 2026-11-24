// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const rpcMock = vi.hoisted(() => ({
  apiKeys: { list: vi.fn(), create: vi.fn(), revoke: vi.fn() },
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
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  useCopyText: () => [false, () => undefined],
}));
vi.mock("../account/ConfirmIdentityDialog", () => ({
  useIdentityConfirmation: () => ({
    withIdentityConfirmation: <T,>(action: () => Promise<T>) => action(),
    identityDialog: null,
  }),
}));
vi.mock("../ConfirmDialog", () => ({
  ConfirmDialog: ({ onConfirm }: { onConfirm: () => void }) => (
    <button type="button" data-testid="confirm-delete" onClick={onConfirm} />
  ),
}));

import { QueryUserProvider } from "../../lib/query/query";
import { ApiKeysSettings } from "./ApiKeysSettings";

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

const saved = {
  id: "key-1",
  name: "laptop",
  start: "rkz_ab",
  createdAt: "2026-11-25T00:00:00.000Z",
  lastUsedAt: null,
};

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

it("shows a new key once, then lists and deletes it", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  rpcMock.apiKeys.list.mockResolvedValueOnce([]).mockResolvedValue([saved]);
  rpcMock.apiKeys.create.mockResolvedValue({ ...saved, key: "rkz_abcdef" });
  rpcMock.apiKeys.revoke.mockResolvedValue({ ok: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <QueryUserProvider value="user-1">
          <ApiKeysSettings />
        </QueryUserProvider>
      </QueryClientProvider>,
    );
  });
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((node) => node.textContent === label)!;

  await act(async () => button("Create key").click());
  await act(async () => typeInto(container.querySelector("input")!, " laptop "));
  await act(async () => container.querySelector("form")!.requestSubmit());
  await vi.waitFor(() =>
    expect(container.querySelector("[data-testid='api-key-created']")?.textContent).toContain(
      "rkz_abcdef",
    ),
  );
  expect(rpcMock.apiKeys.create).toHaveBeenCalledWith({ name: "laptop" });
  await vi.waitFor(() => expect(container.textContent).toContain("rkz_ab…"));

  await act(async () =>
    (container.querySelector("[aria-label='Delete laptop']") as HTMLButtonElement).click(),
  );
  await act(async () =>
    (container.querySelector("[data-testid='confirm-delete']") as HTMLButtonElement).click(),
  );
  await vi.waitFor(() => expect(rpcMock.apiKeys.revoke).toHaveBeenCalledWith({ id: "key-1" }));
  await act(async () => root.unmount());
  container.remove();
});
