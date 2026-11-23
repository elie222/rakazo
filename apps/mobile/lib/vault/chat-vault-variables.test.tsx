// @vitest-environment jsdom

import type { VaultVariables } from "@rakazo/chat-ui/native";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetI18nForTests } from "../i18n/i18n";
import { queryClient } from "../query/query";

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  alert: vi.fn(),
  push: vi.fn(),
  overrides: [] as string[],
  vaults: {} as Record<string, { name: string; auth: { type: string } }[]>,
}));

vi.mock("../api/api", () => ({
  rpc: state.rpc,
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => "space-1",
  subscribeSpaceSelection: () => () => undefined,
  captureApiRequestContext: async (spaceId: string) => ({ headers: { space: spaceId } }),
}));
vi.mock("../api/session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("expo-router", () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock("react-native", () => ({ Alert: { alert: state.alert } }));

import { useChatVaultVariables } from "./chat-vault-variables";

let root: Root;
let container: HTMLDivElement;
let variables: VaultVariables | undefined;

function Probe() {
  variables = useChatVaultVariables();
  return null;
}

/** As a message naming a variable does, then once the reads land. */
async function readVariables() {
  await act(async () => root.render(createElement(Probe)));
  await act(async () => variables?.want());
  await vi.waitFor(() => expect(variables?.names).toBeDefined());
  return variables!;
}

beforeEach(() => {
  resetI18nForTests();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  queryClient.clear();
  state.push.mockReset();
  state.alert.mockReset();
  state.overrides = [];
  state.vaults = {};
  state.rpc.mockReset().mockImplementation(async (proc: string, input?: { scope: string }) => {
    if (proc === "spaceSettings/overrides") return state.overrides;
    if (proc === "vault/list") return state.vaults[input!.scope] ?? [];
    throw new Error(`Unexpected RPC: ${proc}`);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("reads no Vault until a message could name a variable", async () => {
  await act(async () => root.render(createElement(Probe)));
  expect(state.rpc).not.toHaveBeenCalled();
  expect(variables?.names).toBeUndefined();
});

it("opens the account's Vault at a command variable, and the Space's own at one it holds", async () => {
  state.overrides = ["credentials"];
  state.vaults = {
    account: [
      { name: "deploy-key", auth: { type: "command" } },
      { name: "home", auth: { type: "login" } },
    ],
    space: [{ name: "team-key", auth: { type: "command" } }],
  };
  const vault = await readVariables();
  expect([...vault.names!]).toEqual(["DEPLOY_KEY", "TEAM_KEY"]);
  vault.open("DEPLOY_KEY");
  expect(state.push).toHaveBeenLastCalledWith({
    pathname: "/vault",
    params: { item: "deploy-key" },
  });
  vault.open("TEAM_KEY");
  expect(state.push).toHaveBeenLastCalledWith({
    pathname: "/vault",
    params: { item: "team-key", spaceId: "space-1" },
  });
});

it("says in a native alert that a Vault secret can't be opened", async () => {
  const vault = await readVariables();
  vault.denied();
  expect(state.alert).toHaveBeenCalledWith("You don't have access to this Vault secret.");
  expect(state.push).not.toHaveBeenCalled();
});
