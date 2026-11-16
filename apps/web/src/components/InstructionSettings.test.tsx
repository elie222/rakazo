// @vitest-environment jsdom
import type { Bot } from "@rakazo/contracts";
import { deferred } from "@rakazo/core/test-async";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  restoreInstructions: vi.fn(),
  update: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
}));
vi.mock("../lib/rpc", () => {
  const rpc = { bots: api };
  return { rpc, rpcForSpace: () => rpc, createSpaceRpc: () => rpc, selectedSpaceId: () => null };
});
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));

import { useSpaceQueries } from "../lib/query";
import { InstructionSettings } from "./InstructionSettings";

const bot = {
  id: "fixture",
  instructions: "Current",
  instructionHistory: [
    {
      id: "version",
      instructions: "Earlier",
      createdAt: "2026-10-01T00:00:00Z",
      reason: "Manual edit",
    },
  ],
} as Bot;

/** Another screen that lists the space's bots, instructions included. */
function Roster() {
  useQuery(useSpaceQueries().bots.list.queryOptions());
  return null;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const call of Object.values(api)) call.mockReset();
  api.list.mockResolvedValue([bot]);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <Roster />
        <InstructionSettings bot={bot} />
      </QueryClientProvider>,
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const field = () => host.querySelector("textarea")!;
async function edit(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      field(),
      value,
    );
    field().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const leave = () =>
  act(async () => field().dispatchEvent(new FocusEvent("focusout", { bubbles: true })));

it("keeps history behind its label action and restores with the current baseline", async () => {
  api.restoreInstructions.mockResolvedValue({ ...bot, instructions: "Earlier" });
  expect(document.body.textContent).not.toContain("Manual edit");
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Instruction history"]')!.click(),
  );
  expect(document.body.textContent).toContain("Manual edit");
  await act(async () =>
    [...document.body.querySelectorAll("button")]
      .find((button) => button.textContent === "Restore")!
      .click(),
  );
  expect(api.restoreInstructions).toHaveBeenCalledWith({
    botId: "fixture",
    versionId: "version",
    expectedInstructions: "Current",
  });
  expect(host.querySelector("textarea")?.value).toBe("Earlier");
});

it("holds the field while an edit saves, then reads the bots again", async () => {
  const saving = deferred<Bot>();
  api.update.mockReturnValue(saving.promise);
  await edit("Edited");
  await leave();
  expect(api.update.mock.calls).toEqual([
    [{ botId: "fixture", instructions: "Edited", expectedInstructions: "Current" }],
  ]);
  expect(field().disabled).toBe(true);

  await act(async () => saving.resolve({ ...bot, instructions: "Edited" }));
  await vi.waitFor(() => expect(field().disabled).toBe(false));
  expect(api.list).toHaveBeenCalledTimes(2);
  expect(field().value).toBe("Edited");
});

it("says why an edit was not saved, keeps it and offers the field again", async () => {
  api.update.mockRejectedValue(new TypeError("Failed to fetch"));
  await edit("Edited");
  await leave();
  await vi.waitFor(() => expect(host.textContent).toContain("Could not reach the server"));
  expect(field().disabled).toBe(false);
  expect(field().value).toBe("Edited");
  expect(api.list).toHaveBeenCalledTimes(1);
});
