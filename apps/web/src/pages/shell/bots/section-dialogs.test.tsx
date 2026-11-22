// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import type { AccountItem } from "@rakazo/contracts";
import { deferred, flush } from "@rakazo/core/test-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../../../lib/query/rpc", () => ({
  rpc: {},
  rpcForSpace: () => ({}),
  createSpaceRpc: () => ({}),
  selectedSpaceId: () => null,
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: String.raw.bind(null) }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import {
  NewBotSectionDialog,
  NewSpaceDialog,
  RenameBotSectionDialog,
} from "../create-delete-dialogs";

let root: Root;
let host: HTMLDivElement;
let queryClient: QueryClient;

beforeEach(() => {
  i18n.load("en", {});
  i18n.activate("en");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  queryClient = new QueryClient();
});

afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  host.remove();
  vi.unstubAllGlobals();
});

async function render(dialog: ReactNode) {
  await act(async () => {
    root.render(<QueryClientProvider client={queryClient}>{dialog}</QueryClientProvider>);
  });
}

const noop = () => undefined;
const noItems = async () => [];
const noChoice = async () => undefined;
const alerts = () => [...document.querySelectorAll('[role="alert"]')];
const dialog = () => document.querySelector('[role="dialog"]');
const fixtureFailure = () => new Error("INTERNAL_ERROR");

async function enterName(name: string) {
  const input = dialog()?.querySelector("input");
  if (!input) throw new Error("Missing name input");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, name);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(label: string) {
  const button = [...(dialog()?.querySelectorAll("button") ?? [])].find(
    (node) => node.textContent === label,
  );
  if (!button) throw new Error(`Missing ${label} button`);
  await act(async () => button.click());
}

type Save = (name: string) => Promise<string>;

it.each([
  {
    label: "Create space",
    message: "Could not create space",
    create: (save: Save) => (
      <NewSpaceDialog
        onCancel={noop}
        onCreate={save}
        loadItems={noItems}
        chooseItems={noChoice}
        onDone={noop}
      />
    ),
  },
  {
    label: "Create",
    message: "Could not create section",
    create: (save: Save) => (
      <NewBotSectionDialog
        bot={{ name: "Sample bot" }}
        onCancel={noop}
        onConfirm={async (name) => {
          await save(name);
        }}
      />
    ),
  },
  {
    label: "Save",
    message: "Could not rename section",
    create: (save: Save) => (
      <RenameBotSectionDialog
        section={{ name: "Previous name" }}
        onCancel={noop}
        onConfirm={async (name) => {
          await save(name);
        }}
      />
    ),
  },
])(
  "announces one inline failure after $label, not before or on successful retry",
  async ({ label, message, create }) => {
    const pending = deferred<string>();
    const save = vi.fn<Save>().mockReturnValueOnce(pending.promise).mockResolvedValue("new-space");
    await render(create(save));
    expect(alerts()).toHaveLength(0);
    await enterName("  Local draft  ");
    await click(label);
    expect(save.mock.calls[0]?.[0]).toBe("Local draft");
    expect(alerts()).toHaveLength(0);

    await act(async () => pending.reject(fixtureFailure()));
    expect(dialog()?.textContent).toContain(message);
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]?.textContent).toBe(message);
    expect(dialog()?.contains(alerts()[0] ?? null)).toBe(true);
    expect(dialog()?.querySelector("input")?.value).toBe("  Local draft  ");

    await click(label);
    await act(flush);
    expect(save).toHaveBeenCalledTimes(2);
    expect(alerts()).toHaveLength(0);
  },
);

it("announces the existing inline save failure on the new space's second step", async () => {
  const item: AccountItem = {
    kind: "skill",
    id: "sample-skill",
    name: "Sample skill",
    availability: { allSpaces: true, spaceIds: ["sample-space"] },
  };
  const chooseItems = vi.fn().mockRejectedValue(fixtureFailure());
  const onDone = vi.fn();
  await render(
    <NewSpaceDialog
      onCancel={noop}
      onCreate={async () => "new-space"}
      loadItems={async () => [item]}
      chooseItems={chooseItems}
      onDone={onDone}
    />,
  );
  await enterName("Local draft");
  await click("Create space");
  await act(flush);
  expect(alerts()).toHaveLength(0);

  await click("Continue");
  expect(chooseItems.mock.calls[0]?.slice(0, 2)).toEqual(["new-space", [item]]);
  expect(onDone).not.toHaveBeenCalled();
  expect(dialog()?.textContent).toContain("Could not save");
  expect(alerts()).toHaveLength(1);
  expect(alerts()[0]?.textContent).toBe("Could not save");
});
