// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { organizations, wrote } = vi.hoisted(() => ({
  organizations: { list: vi.fn(), rename: vi.fn() },
  /** The space each rename named. */
  wrote: [] as (string | null)[],
}));
vi.mock("../lib/rpc", async (original) => {
  const clientFor = (spaceId: string | null) => ({
    organizations: {
      list: organizations.list,
      rename: (input: unknown) => {
        wrote.push(spaceId);
        return organizations.rename(input);
      },
    },
  });
  return {
    ...((await original()) as object),
    rpc: clientFor(null),
    createSpaceRpc: clientFor,
    rpcForSpace: clientFor,
    selectedSpaceId: () => "space-work",
  };
});
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});
vi.mock("@rakazo/ui-web", () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: (props: ComponentProps<"button">) => <button type="button" {...props} />,
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
      open ? <div>{children}</div> : null,
    DialogContent: Box,
    DialogFooter: Box,
    DialogHeader: Box,
    DialogTitle: Box,
    Field: Box,
    FieldError: Box,
    FieldLabel: ({ children, htmlFor }: ComponentProps<"label">) => (
      <label htmlFor={htmlFor}>{children}</label>
    ),
    AlertDialog: Box,
    AlertDialogAction: (props: ComponentProps<"button">) => <button type="button" {...props} />,
    AlertDialogCancel: (props: ComponentProps<"button">) => <button type="button" {...props} />,
    AlertDialogContent: Box,
    AlertDialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
    AlertDialogFooter: Box,
    AlertDialogHeader: Box,
    AlertDialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  };
});
vi.mock("../lib/auth", () => ({ authClient: { $store: { notify: vi.fn() } } }));

import { QueryClientProvider } from "@tanstack/react-query";
import { useOrganizations } from "../lib/organizations";
import { QueryUserProvider, queryClient } from "../lib/query";
import { SpaceRpcProvider } from "../lib/space-rpc";
import { DeleteOrganizationDialog, OrganizationSettingsPanel } from "./OrganizationSettingsPanel";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("enables Delete only once the organization's exact name is typed", async () => {
  const onConfirm = vi.fn(async () => undefined);
  await act(async () =>
    root.render(
      <DeleteOrganizationDialog
        organization={{
          id: "org-work",
          name: "Work",
          defaultSpaceId: "s2",
          spaceIds: ["s2"],
          canManage: true,
        }}
        onCancel={() => undefined}
        onConfirm={onConfirm}
      />,
    ),
  );
  const label = container.querySelector("label")!;
  expect(label.textContent).toBe("Type Work to confirm");
  const input = container.querySelector<HTMLInputElement>(`#${CSS.escape(label.htmlFor)}`)!;
  const remove = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Delete",
  )!;
  expect(remove.disabled).toBe(true);
  for (const wrong of ["work", "Wor", "Work "]) {
    await type(input, wrong);
    expect(remove.disabled).toBe(true);
  }
  await type(input, "Work");
  expect(remove.disabled).toBe(false);
  await act(async () => remove.click());
  expect(onConfirm).toHaveBeenCalledOnce();
});

describe("renaming the organization", () => {
  const listed = (name: string) => ({
    organizations: [
      {
        id: "org-work",
        name,
        defaultSpaceId: "space-work",
        spaceIds: ["space-work"],
        canManage: true,
      },
    ],
    activeOrganizationId: "org-work",
  });
  const onBusyChange = vi.fn();

  /** Another screen that lists organizations, as the account menu does. */
  function Names() {
    const { organizations } = useOrganizations();
    return (
      <ul>
        {organizations.map((organization) => (
          <li key={organization.id}>{organization.name}</li>
        ))}
      </ul>
    );
  }
  async function render(panel = true) {
    await act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <QueryUserProvider value="user-a">
            <SpaceRpcProvider spaceId="space-work">
              {panel ? <OrganizationSettingsPanel onBusyChange={onBusyChange} /> : null}
              <Names />
            </SpaceRpcProvider>
          </QueryUserProvider>
        </QueryClientProvider>,
      ),
    );
    await settle();
  }
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }
  async function settle() {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  const nameInput = () => container.querySelector("input")!;
  const names = () => [...container.querySelectorAll("li")].map((item) => item.textContent);
  const alert = () => container.querySelector('[role="alert"]')?.textContent ?? null;
  const commit = () => nameInput().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));

  beforeEach(() => {
    queryClient.clear();
    queryClient.setDefaultOptions({ queries: { retry: false } });
    wrote.length = 0;
    onBusyChange.mockReset();
    organizations.rename.mockReset().mockResolvedValue({ id: "org-work", name: "Team" });
    organizations.list.mockReset().mockResolvedValue(listed("Work"));
  });

  it("renames once for two commits in one tick, in the window's space, and holds the field until every list shows the name", async () => {
    await render();
    const reread = deferred<ReturnType<typeof listed>>();
    organizations.list.mockReturnValue(reread.promise);
    await type(nameInput(), "  Team  ");
    await act(async () => {
      commit();
      commit();
    });
    await settle();
    expect(organizations.rename.mock.calls).toEqual([
      [{ organizationId: "org-work", name: "Team" }],
    ]);
    expect(wrote).toEqual(["space-work"]);
    expect(names()).toEqual(["Work"]);
    expect(nameInput().disabled).toBe(true);
    expect(onBusyChange).toHaveBeenLastCalledWith(true);

    await act(async () => reread.resolve(listed("Team")));
    await settle();
    expect(names()).toEqual(["Team"]);
    expect(nameInput().disabled).toBe(false);
    expect(nameInput().value).toBe("Team");
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
    expect(alert()).toBeNull();
  });

  it("keeps a rename when reading the list again fails", async () => {
    await render();
    organizations.list.mockRejectedValue(new Error("offline"));
    await type(nameInput(), "Team");
    await act(async () => commit());
    await settle();
    expect(organizations.list).toHaveBeenCalledTimes(2);
    expect(alert()).toBeNull();
    expect(nameInput().disabled).toBe(false);
    expect(nameInput().value).toBe("Team");
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it("shows why a rename failed, keeps the draft, and forgets the failure once the name changes", async () => {
    organizations.rename.mockRejectedValue(new TypeError("Failed to fetch"));
    await render();
    await type(nameInput(), "Team");
    await act(async () => commit());
    await settle();
    expect(alert()).toBe("Could not reach the server");
    expect(nameInput().disabled).toBe(false);
    expect(nameInput().value).toBe("Team");
    expect(organizations.list).toHaveBeenCalledTimes(1);

    await type(nameInput(), "Team 2");
    expect(alert()).toBeNull();

    await act(async () => commit());
    await settle();
    expect(alert()).toBe("Could not reach the server");
    // An emptied name goes back to the current one without a request.
    await type(nameInput(), " ");
    await act(async () => commit());
    expect(alert()).toBeNull();
    expect(nameInput().value).toBe("Work");
    expect(organizations.rename).toHaveBeenCalledTimes(2);
  });

  it("still shows the new name elsewhere when the panel has gone before the rename ends", async () => {
    const renaming = deferred<{ id: string; name: string }>();
    organizations.rename.mockReturnValue(renaming.promise);
    await render();
    await type(nameInput(), "Team");
    await act(async () => commit());
    await render(false);
    organizations.list.mockResolvedValue(listed("Team"));
    await act(async () => renaming.resolve({ id: "org-work", name: "Team" }));
    await settle();
    expect(names()).toEqual(["Team"]);
  });
});
