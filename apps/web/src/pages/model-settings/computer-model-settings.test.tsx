// @vitest-environment jsdom

import type { ComputerModelTarget } from "@rakazo/contracts";
import { computerModelKey } from "@rakazo/core";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { client } = vi.hoisted(() => ({
  client: { models: { computer: vi.fn(), setComputer: vi.fn() } },
}));
vi.mock("../../lib/space-rpc", () => ({ useSpaceRpc: () => client }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join("") }),
}));
vi.mock("../../lib/model-catalog", () => ({ thinkingLevelLabel: (level: string) => level }));

import { ComputerModelSettings } from "./computer-model-settings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const option = {
  mode: "model" as const,
  provider: "openai",
  credentialId: "conn",
  modelId: "gpt-4o",
  label: "GPT-4o",
  thinkingLevels: ["low", "medium", "high"],
};
const empty = { selection: null, options: [option] };
beforeEach(() => {
  client.models.computer.mockReset().mockResolvedValue(empty);
  client.models.setComputer.mockReset();
});
afterEach(() => {
  document.body.innerHTML = "";
});
async function render(target: ComputerModelTarget = { kind: "bot", botId: "bot" }) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(<ComputerModelSettings target={target} userId="user" spaceId="space" />),
  );
  return { host, unmount: () => act(() => root.unmount()) };
}
async function select(node: HTMLSelectElement, value: string) {
  await act(async () => {
    node.value = value;
    node.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
it("labels inherit and same-main distinctly, then persists only the exact selected connection", async () => {
  client.models.setComputer.mockImplementation(async ({ selection }) => ({ ...empty, selection }));
  const { host, unmount } = await render();
  expect(host.textContent).toContain("Computer-use model");
  expect(host.textContent).toContain("Use provider default");
  expect(host.textContent).toContain("Same as main model");
  const picker = host.querySelector("select")!;
  await select(picker, computerModelKey(option));
  expect(client.models.setComputer).toHaveBeenCalledWith({
    expectedUserId: "user",
    target: { kind: "bot", botId: "bot" },
    selection: {
      mode: "model",
      provider: "openai",
      credentialId: "conn",
      modelId: "gpt-4o",
      thinkingLevel: null,
    },
  });
  expect(host.querySelector("details")?.open).toBe(false);
  expect(host.textContent).toContain("Default (Medium)");
  await select(host.querySelectorAll("select")[1]!, "low");
  expect(client.models.setComputer).toHaveBeenLastCalledWith(
    expect.objectContaining({ selection: expect.objectContaining({ thinkingLevel: "low" }) }),
  );
  await select(picker, "main");
  expect(client.models.setComputer).toHaveBeenLastCalledWith(
    expect.objectContaining({ selection: { mode: "main" } }),
  );
  await select(picker, "inherit");
  expect(client.models.setComputer).toHaveBeenLastCalledWith(
    expect.objectContaining({ selection: null }),
  );
  unmount();
});
it("connection defaults show same-main, with no implicit vendor choice", async () => {
  const { host, unmount } = await render({
    kind: "connection",
    credentialId: "conn",
    scope: "space",
  });
  expect(host.querySelector("select")?.value).toBe("inherit");
  expect(host.textContent).not.toContain("Use provider default");
  expect(client.models.computer).toHaveBeenCalledWith({
    expectedUserId: "user",
    target: { kind: "connection", credentialId: "conn", scope: "space" },
  });
  expect(client.models.setComputer).not.toHaveBeenCalled();
  unmount();
});
it.each(["account", "space", "bot"] as const)(
  "selects cross-provider/auth targets with exact readback in %s scope",
  async (scope) => {
    const other = {
      ...option,
      provider: "openai-codex",
      credentialId: "codex-target",
      modelId: "gpt-5.3-codex",
      label: "Codex account (OAuth)",
    };
    const view = { selection: null, options: [option, other] };
    client.models.computer.mockResolvedValue(view);
    client.models.setComputer.mockImplementation(async ({ selection }) => ({ ...view, selection }));
    const target: ComputerModelTarget =
      scope === "bot"
        ? { kind: "bot", botId: "bot" }
        : { kind: "connection", scope, credentialId: "claude-main" };
    const { host, unmount } = await render(target);
    await select(host.querySelector("select")!, computerModelKey(other));
    expect(client.models.setComputer).toHaveBeenLastCalledWith({
      expectedUserId: "user",
      target,
      selection: {
        mode: "model",
        provider: other.provider,
        modelId: other.modelId,
        credentialId: other.credentialId,
        thinkingLevel: null,
      },
    });
    expect(host.querySelector("select")!.value).toBe(computerModelKey(other));
    expect(host.textContent).toContain("Codex account (OAuth)");
    unmount();
  },
);
it("shows loading, error and retry instead of a false saved default", async () => {
  let reject!: (reason: Error) => void;
  client.models.computer.mockReturnValueOnce(
    new Promise((_, r) => {
      reject = r;
    }),
  );
  const { host, unmount } = await render({ kind: "bot", botId: "loading-test" });
  expect(host.textContent).toContain("Loading…");
  expect(host.querySelector("select")).toBeNull();
  await act(async () => reject(new Error("offline")));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("offline");
  await act(async () => host.querySelector("button")!.click());
  expect(host.querySelector("select")).not.toBeNull();
  unmount();
});
it("retains a failed selection and disables edits until readback retry succeeds", async () => {
  client.models.computer.mockResolvedValue({
    ...empty,
    selection: { ...option, thinkingLevel: null },
  });
  client.models.setComputer.mockRejectedValue(new Error("write failed"));
  const { host, unmount } = await render();
  await select(host.querySelector("select")!, "main");
  expect(host.querySelector("select")?.value).toBe(computerModelKey(option));
  expect(host.querySelector("select")?.disabled).toBe(true);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("write failed");
  await act(async () => host.querySelector("button")!.click());
  expect(host.querySelector("select")?.disabled).toBe(false);
  unmount();
});
