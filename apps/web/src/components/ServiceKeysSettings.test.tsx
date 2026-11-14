// @vitest-environment jsdom

import { IDENTITY_CONFIRMATION_REQUIRED } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  revoke: vi.fn(),
  bots: vi.fn(),
}));
const confirm = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock("@lingui/react/macro", () => {
  const t = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((text, part, index) => `${text}${part}${values[index] ?? ""}`, "");
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});
vi.mock("./ConfirmIdentityDialog", () => ({
  useIdentityConfirmation: () => ({
    withIdentityConfirmation: <T,>(action: () => Promise<T>) => confirm.run(action),
    identityDialog: null,
  }),
}));
vi.mock("../lib/space-rpc", () => ({
  useSpaceRpc: () => ({
    serviceCredentials: { create: rpc.create, revoke: rpc.revoke },
  }),
}));
vi.mock("../lib/query", () => ({
  useSpaceQueries: () => ({
    serviceCredentials: {
      list: { queryOptions: () => ({ queryKey: ["keys"], queryFn: rpc.list }) },
    },
    bots: { list: { queryOptions: () => ({ queryKey: ["bots"], queryFn: rpc.bots }) } },
  }),
}));

import { ServiceKeysSettings } from "./ServiceKeysSettings";

const key = {
  id: "key-1",
  name: "Nightly",
  tokenPrefix: "rks_abcdef",
  scopes: ["bots:read"],
  botIds: [],
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  revokedAt: null,
  lastUsedAt: null,
  createdAt: new Date().toISOString(),
};

describe("ServiceKeysSettings", () => {
  let container: HTMLDivElement;
  let root: Root;

  const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  const button = (name: string) =>
    [...container.querySelectorAll("button")].find((entry) => entry.textContent === name);
  const typeName = (value: string) => {
    const input = container.querySelector<HTMLInputElement>("input:not([type=checkbox])")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };

  const render = async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <ServiceKeysSettings />
        </QueryClientProvider>,
      );
    });
    await settle();
  };

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    confirm.run.mockImplementation((action: () => Promise<unknown>) => action());
    rpc.list.mockResolvedValue([key]);
    rpc.bots.mockResolvedValue([{ id: "bot-1", name: "Worker" }]);
    await render();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("shows a new key once and asks for the chosen bots and scope", async () => {
    rpc.create.mockResolvedValue({ credential: key, token: "rks_secret" });
    await act(async () => typeName("Nightly"));
    const box = (label: string) =>
      [...container.querySelectorAll("label")].find((entry) => entry.textContent === label);
    const canSend = box("prompts:write");
    const bot = box("Worker");
    await act(async () => canSend?.click());
    await act(async () => bot?.click());
    await act(async () => button("Create key")?.click());
    await settle();
    expect(rpc.create).toHaveBeenCalledWith({
      name: "Nightly",
      scopes: ["bots:read", "prompts:write"],
      botIds: ["bot-1"],
      expiresInDays: 90,
    });
    expect(container.textContent).toContain("rks_secret");
  });

  it("keeps a new key on screen when a different key is revoked", async () => {
    rpc.create.mockResolvedValue({ credential: { ...key, id: "key-2" }, token: "rks_new" });
    rpc.revoke.mockResolvedValue({ ok: true });
    await act(async () => typeName("Backup"));
    await act(async () => button("Create key")?.click());
    await settle();
    await act(async () => button("Revoke")?.click());
    await settle();
    expect(rpc.revoke).toHaveBeenCalledWith({ id: "key-1" });
    expect(container.textContent).toContain("rks_new");
  });

  it("treats a closed identity confirmation as a choice, not a failure", async () => {
    confirm.run.mockRejectedValue({ code: IDENTITY_CONFIRMATION_REQUIRED });
    await act(async () => typeName("Nightly"));
    await act(async () => button("Create key")?.click());
    await settle();
    expect(container.querySelector("[role=alert]")).toBeNull();
  });

  it("revokes a key and hides the action once it is revoked", async () => {
    rpc.revoke.mockResolvedValue({ ok: true });
    rpc.list.mockResolvedValue([{ ...key, revokedAt: new Date().toISOString() }]);
    await act(async () => button("Revoke")?.click());
    await settle();
    expect(rpc.revoke).toHaveBeenCalledWith({ id: "key-1" });
    expect(button("Revoke")).toBeUndefined();
    expect(container.textContent).toContain("Revoked");
  });

  it("names each revoke button after its key", () => {
    expect(button("Revoke")?.getAttribute("aria-label")).toBe("Revoke Nightly");
  });

  it("does not create a key for every bot when the bot list fails to load", async () => {
    act(() => root.unmount());
    container.remove();
    rpc.bots.mockRejectedValue(new Error("down"));
    await render();
    await act(async () => typeName("Nightly"));
    expect(button("Create key")?.disabled).toBe(true);
    await act(async () => button("Create key")?.click());
    await settle();
    expect(rpc.create).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Could not load your bots");
  });
});
