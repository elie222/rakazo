// @vitest-environment jsdom
import { flush } from "@rakazo/core/test-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const rpcMock = vi.hoisted(() => ({ scratchpad: { list: vi.fn(), remove: vi.fn() } }));
vi.mock("../../../lib/query/rpc", () => ({
  rpc: rpcMock,
  rpcForSpace: () => rpcMock,
  createSpaceRpc: () => rpcMock,
  selectedSpaceId: () => null,
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
  }),
}));

import { OpenWorkEventRow } from "./open-work-event-row";

const item = {
  id: "item-1",
  botId: "bot-1",
  title: "Compare vendors",
  notes: "",
  status: "open" as const,
  createdAt: "",
  updatedAt: "",
};
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  rpcMock.scratchpad.list.mockReset().mockResolvedValue([item]);
  rpcMock.scratchpad.remove.mockReset().mockResolvedValue({ ok: true });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function mount(botId: string | undefined = "bot-1") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <OpenWorkEventRow
          block={{ kind: "open_work_event", itemId: "item-1", title: "Compare vendors" }}
          botId={botId}
        />
      </QueryClientProvider>,
    ),
  );
  await act(flush);
}
const removeButton = () => container.querySelector<HTMLButtonElement>('[aria-label="Remove"]');

it("names the item and removes it from the row", async () => {
  await mount();
  expect(container.textContent).toBe('Added to open work "Compare vendors"');
  rpcMock.scratchpad.list.mockResolvedValue([]);
  await act(async () => removeButton()!.click());
  await act(flush);
  expect(rpcMock.scratchpad.remove).toHaveBeenCalledExactlyOnceWith({ itemId: "item-1" });
  expect(removeButton()).toBeNull();
  expect(container.textContent).toBe('Added to open work "Compare vendors"');
});

it("says so when the removal fails and keeps Remove for another try", async () => {
  rpcMock.scratchpad.remove.mockRejectedValue(new Error("Request failed"));
  await mount();
  await act(async () => removeButton()!.click());
  await act(flush);
  expect(container.textContent).toBe('Added to open work "Compare vendors"Could not remove');
  expect(removeButton()!.disabled).toBe(false);
});

it("offers no removal once the item is finished or gone, or without its bot", async () => {
  rpcMock.scratchpad.list.mockResolvedValue([{ ...item, id: "another" }]);
  await mount();
  expect(removeButton()).toBeNull();
  await mount(undefined);
  expect(removeButton()).toBeNull();
});
