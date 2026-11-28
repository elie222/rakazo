// @vitest-environment jsdom

import { LinkifiedText, VaultVariablesContext } from "@rakazo/chat-ui/web";
import type { BotSecretMetadata, SettingsScope } from "@rakazo/contracts";
import { flush } from "@rakazo/core/test-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const vault = vi.hoisted(() => ({ list: vi.fn() }));
const spaceSettings = vi.hoisted(() => ({ overrides: vi.fn() }));
const toast = vi.hoisted(() => vi.fn());

vi.mock("../../lib/query/rpc", () => ({
  rpc: { vault, spaceSettings },
  rpcForSpace: () => ({ vault, spaceSettings }),
  createSpaceRpc: () => ({ vault, spaceSettings }),
  selectedSpaceId: () => null,
}));
vi.mock("@rakazo/ui-web", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/ui-web")>()),
  toast,
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

import { useChatVaultVariables } from "./use-chat-vault-variables";

const item = (name: string, type: "command" | "login") =>
  ({
    name,
    title: name,
    origin: "",
    note: "",
    auth: { type },
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  }) as BotSecretMetadata;

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
const openVault = vi.fn<(scope: SettingsScope, item: string) => void>();

function Chat({ children, other }: { children: string; other?: string }) {
  const variables = useChatVaultVariables(openVault);
  return (
    <VaultVariablesContext.Provider value={variables}>
      {other ? <LinkifiedText fromOtherPerson>{other}</LinkifiedText> : null}
      <LinkifiedText>{children}</LinkifiedText>
    </VaultVariablesContext.Provider>
  );
}

function Pair() {
  const variables = useChatVaultVariables(openVault);
  return (
    <VaultVariablesContext.Provider value={variables}>
      <LinkifiedText>{"Use [saved as $FIRST_KEY]"}</LinkifiedText>
      <LinkifiedText>{"Use [saved as $SECOND_KEY]"}</LinkifiedText>
    </VaultVariablesContext.Provider>
  );
}

async function render(text: string, other?: string) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <Chat other={other}>{text}</Chat>
      </QueryClientProvider>,
    );
  });
  await act(flush);
}

async function tap(text: string) {
  const chip = await vi.waitFor(() => {
    const found = [...container.querySelectorAll("button")].find((b) => b.textContent === text);
    if (!found) throw new Error(`No link for ${text}`);
    return found;
  });
  await act(async () => chip.click());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vault.list.mockReset();
  spaceSettings.overrides.mockReset().mockResolvedValue([]);
  openVault.mockReset();
  toast.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  container.remove();
});

describe("Vault variables in chat", () => {
  it("opens the account's Vault at a command variable, and links no other kind of item", async () => {
    vault.list.mockResolvedValue([item("deploy-key", "command"), item("home", "login")]);
    await render("Deploy with $DEPLOY_KEY from $HOME");
    expect(vault.list).toHaveBeenCalledTimes(1);
    expect(vault.list).toHaveBeenCalledWith({ scope: "account" }, expect.anything());
    expect([...container.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "$DEPLOY_KEY",
    ]);
    await tap("$DEPLOY_KEY");
    expect(openVault).toHaveBeenCalledWith("account", "deploy-key");
  });

  it("opens a Space's own Vault at a variable it holds", async () => {
    spaceSettings.overrides.mockResolvedValue(["credentials"]);
    vault.list.mockImplementation(async ({ scope }: { scope: SettingsScope }) =>
      scope === "space" ? [item("team-key", "command")] : [item("own-key", "command")],
    );
    await render("Use $TEAM_KEY or $OWN_KEY");
    await tap("$TEAM_KEY");
    expect(openVault).toHaveBeenLastCalledWith("space", "team-key");
    await tap("$OWN_KEY");
    expect(openVault).toHaveBeenLastCalledWith("account", "own-key");
  });

  it("says a saved secret the viewer doesn't have can't be opened", async () => {
    vault.list.mockResolvedValue([]);
    await render("Use [saved as $PASTED_KEY]");
    await tap("$PASTED_KEY");
    expect(openVault).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("You don't have access to this Vault secret.");
  });

  it("reads the Vault again once for a saved placeholder it didn't have, as one just pasted", async () => {
    vault.list.mockResolvedValueOnce([]).mockResolvedValue([item("pasted-key", "command")]);
    await render("Deploy with [saved as $PASTED_KEY]");
    await vi.waitFor(() => expect(container.querySelector("button")?.dataset.access).toBe("own"));
    expect(vault.list).toHaveBeenCalledTimes(2);
    await tap("$PASTED_KEY");
    expect(openVault).toHaveBeenCalledWith("account", "pasted-key");
  });

  it("reads the Vault again once for two messages naming different new placeholders", async () => {
    vault.list.mockResolvedValue([]);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Pair />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(vault.list).toHaveBeenCalledTimes(2));
    await act(flush);
    expect(vault.list).toHaveBeenCalledTimes(2);
  });

  it("keeps that read for the viewer's own placeholder, not another person's", async () => {
    vault.list.mockResolvedValue([]);
    await render("Deploy", "Use [saved as $DEPLOY_KEY]");
    await vi.waitFor(() => expect(vault.list).toHaveBeenCalledTimes(1));
    await act(flush);
    expect(vault.list).toHaveBeenCalledTimes(1);
    // The viewer then saves their own key of that name, and their message names it.
    vault.list.mockResolvedValue([item("deploy-key", "command")]);
    await render("Mine is [saved as $DEPLOY_KEY]", "Use [saved as $DEPLOY_KEY]");
    await vi.waitFor(() =>
      expect(
        [...container.querySelectorAll("button")].map((button) => button.dataset.access),
      ).toEqual(["none", "own"]),
    );
  });

  it("reads no Vault for a chat that names no variable", async () => {
    await render("Costs $5 today");
    expect(vault.list).not.toHaveBeenCalled();
    expect(spaceSettings.overrides).not.toHaveBeenCalled();
  });
});
