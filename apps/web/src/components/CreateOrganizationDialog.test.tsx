// @vitest-environment jsdom

import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { organizations, openOrganizationSpace } = vi.hoisted(() => ({
  organizations: { create: vi.fn(), list: vi.fn() },
  openOrganizationSpace: vi.fn(),
}));

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: (props: ComponentProps<"button">) => <button {...props} />,
    Input: ({ autoFocus: _autoFocus, ...props }: ComponentProps<"input">) => <input {...props} />,
    Dialog: Box,
    DialogContent: Box,
    DialogFooter: Box,
    DialogHeader: Box,
    DialogTitle: Box,
    Field: Box,
    FieldError: ({ children }: { children?: ReactNode }) => <p role="alert">{children}</p>,
    FieldLabel: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  };
});
vi.mock("../lib/rpc", () => ({
  rpc: { organizations },
  rpcForSpace: () => ({ organizations }),
  createSpaceRpc: () => ({ organizations }),
  selectedSpaceId: () => "space-a",
}));
vi.mock("../lib/organizations", () => ({
  openOrganizationSpace,
  organizationsQuery: (userId: string | null) => ({
    queryKey: [`user:${userId ?? ""}`, "organizations"],
    queryFn: () => organizations.list(),
  }),
}));

import { organizationsQuery } from "../lib/organizations";
import { QueryUserProvider } from "../lib/query";
import { CreateOrganizationDialog } from "./CreateOrganizationDialog";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** The settings page behind the dialog, which shows the list. */
function Page({ dialog }: { dialog: boolean }) {
  useQuery(organizationsQuery("user-a"));
  return dialog ? <CreateOrganizationDialog open onOpenChange={() => undefined} /> : null;
}

let container: HTMLDivElement;
let root: Root;
async function render(dialog = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (shown: boolean) => (
    <QueryClientProvider client={client}>
      <QueryUserProvider value="user-a">
        <Page dialog={shown} />
      </QueryUserProvider>
    </QueryClientProvider>
  );
  await act(async () => root.render(tree(dialog)));
  return { close: () => act(async () => root.render(tree(false))) };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  organizations.create.mockReset();
  organizations.list.mockReset().mockResolvedValue({ organizations: [] });
  openOrganizationSpace.mockReset().mockResolvedValue(true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const input = () => container.querySelector("input")!;
const submit = () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function settle() {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

it("creates once, re-reads the list, then opens the new organization and stays disabled", async () => {
  organizations.create.mockResolvedValue({ id: "org-new", defaultSpaceId: "space-new" });
  await render();
  await type("  Work  ");
  await act(async () => {
    submit().click();
    submit().click();
  });
  await settle();
  expect(organizations.create.mock.calls).toEqual([[{ name: "Work" }]]);
  expect(organizations.list).toHaveBeenCalledTimes(2);
  expect(openOrganizationSpace.mock.calls).toEqual([
    ["user-a", "space-new", "/onboarding", undefined],
  ]);
  expect(submit().disabled).toBe(true);
  expect(input().disabled).toBe(true);
});

it("opens the new organization even when re-reading the list fails", async () => {
  organizations.create.mockResolvedValue({ id: "org-new", defaultSpaceId: "space-new" });
  await render();
  organizations.list.mockRejectedValue(new TypeError("Failed to fetch"));
  await type("Work");
  await act(async () => submit().click());
  await settle();
  expect(openOrganizationSpace).toHaveBeenCalledOnce();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("");
});

it("shows a failure, offers the form again, and forgets the failure once the name changes", async () => {
  organizations.create.mockRejectedValue(new TypeError("Failed to fetch"));
  await render();
  await type("Work");
  await act(async () => submit().click());
  await settle();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not reach the server");
  expect(submit().disabled).toBe(false);
  expect(openOrganizationSpace).not.toHaveBeenCalled();
  await type("Work 2");
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("");
});

it("does not move to the new organization once the dialog has gone", async () => {
  const creating = deferred<{ id: string; defaultSpaceId: string }>();
  organizations.create.mockReturnValue(creating.promise);
  const page = await render();
  await type("Work");
  await act(async () => submit().click());
  await page.close();
  await act(async () => creating.resolve({ id: "org-new", defaultSpaceId: "space-new" }));
  await settle();
  expect(openOrganizationSpace).not.toHaveBeenCalled();
  // The page still showing the list reads the new organization into it.
  expect(organizations.list).toHaveBeenCalledTimes(2);
});
