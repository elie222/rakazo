// @vitest-environment jsdom

import { deferred, flush } from "@rakazo/core/test-async";
import type { ComponentProps, ReactNode } from "react";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { organizations, wrote, toast, copy } = vi.hoisted(() => ({
  organizations: {
    list: vi.fn(),
    rename: vi.fn(),
    members: { list: vi.fn(), setRole: vi.fn(), remove: vi.fn() },
    invitations: { create: vi.fn(), cancel: vi.fn() },
  },
  toast: vi.fn(),
  copy: vi.fn(async () => true),
  /** The space each rename named. */
  wrote: [] as (string | null)[],
}));
vi.mock("../../lib/query/rpc", async (original) => {
  const clientFor = (spaceId: string | null) => ({
    organizations: {
      list: organizations.list,
      members: organizations.members,
      invitations: organizations.invitations,
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
    Badge: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    CopyTextFallback: () => null,
    DropdownMenu: Box,
    DropdownMenuContent: Box,
    DropdownMenuItem: (props: ComponentProps<"button">) => <button type="button" {...props} />,
    DropdownMenuSeparator: () => null,
    DropdownMenuTrigger: () => null,
    toast,
    writeClipboard: copy,
  };
});
vi.mock("../../lib/auth/auth", () => ({ authClient: { $store: { notify: vi.fn() } } }));

import { QueryClientProvider } from "@tanstack/react-query";
import { QueryUserProvider, queryClient } from "../../lib/query/query";
import { SpaceRpcProvider } from "../../lib/query/space-rpc";
import { useOrganizations } from "../../lib/spaces/organizations";
import type { OrganizationPage } from "./OrganizationSettingsPanel";
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
          role: "owner",
          memberCount: 1,
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
        role: "owner",
        memberCount: 1,
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
              {panel ? (
                <OrganizationSettingsPanel
                  page="main"
                  onPageChange={() => {}}
                  onBusyChange={onBusyChange}
                />
              ) : null}
              <Names />
            </SpaceRpcProvider>
          </QueryUserProvider>
        </QueryClientProvider>,
      ),
    );
    await settle();
  }
  async function settle() {
    await act(flush);
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

describe("organization members", () => {
  const organization = (memberCount: number, role = "owner") => ({
    organizations: [
      {
        id: "org-work",
        name: "Work",
        defaultSpaceId: "space-work",
        spaceIds: ["space-work"],
        canManage: role === "owner",
        role,
        memberCount,
      },
    ],
    activeOrganizationId: "org-work",
  });
  const person = (name: string, role: string, manageable: boolean) => ({
    userId: `user-${name}`,
    name,
    email: `${name.split(" ")[0]!.toLowerCase()}@example.test`,
    image: null,
    role,
    manageable,
    roleChangeable: manageable,
  });

  async function render() {
    await act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <QueryUserProvider value="user-a">
            <SpaceRpcProvider spaceId="space-work">
              <Members />
            </SpaceRpcProvider>
          </QueryUserProvider>
        </QueryClientProvider>,
      ),
    );
    await act(flush);
  }
  /** The page the panel is on is the settings window's to keep, as in the real window. */
  function Members() {
    const [page, setPage] = useState<OrganizationPage>("main");
    return <OrganizationSettingsPanel page={page} onPageChange={setPage} />;
  }
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((each) => each.textContent === label);
  const rows = () =>
    [...container.querySelectorAll('ul[aria-label="Members"] > li')].map((row) => row.textContent);

  beforeEach(() => {
    queryClient.clear();
    queryClient.setDefaultOptions({ queries: { retry: false } });
    vi.clearAllMocks();
  });

  it("offers to invite people while the owner is alone, else shows the count", async () => {
    organizations.list.mockResolvedValue(organization(1));
    await render();
    expect(button("MembersInvite people")).toBeTruthy();

    queryClient.clear();
    organizations.list.mockResolvedValue(organization(3, "member"));
    await render();
    expect(button("Members3")).toBeTruthy();
  });

  it("lists members, invites by email and copies the link when no email went out", async () => {
    organizations.list.mockResolvedValue(organization(2));
    organizations.members.list.mockResolvedValue({
      canManage: true,
      members: [person("Ada Lovelace", "owner", false), person("Bob Stone", "member", true)],
      invitations: [],
    });
    await render();
    await act(async () => button("Members2")?.click());
    await act(flush);
    expect(container.querySelector('[data-testid="settings-page-title"]')?.textContent).toBe(
      "Members",
    );
    expect(rows()).toEqual([
      "AAda LovelaceOwnerada@example.test",
      "BBob Stonebob@example.testMake adminRemove",
    ]);

    organizations.invitations.create.mockResolvedValue({
      url: "https://app.example.test/join/invitation-1",
      emailed: false,
    });
    const field = container.querySelector<HTMLInputElement>('input[type="email"]')!;
    await type(field, "cy@example.test");
    await act(async () => field.form?.requestSubmit());
    await act(flush);
    expect(organizations.invitations.create).toHaveBeenCalledWith({
      organizationId: "org-work",
      email: "cy@example.test",
    });
    expect(copy).toHaveBeenCalledWith(
      "https://app.example.test/join/invitation-1",
      expect.any(Function),
    );
    expect(toast).toHaveBeenCalledWith("Invite link copied");

    organizations.members.setRole.mockResolvedValue({ ok: true });
    await act(async () => button("Make admin")?.click());
    await act(flush);
    expect(organizations.members.setRole).toHaveBeenCalledWith({
      organizationId: "org-work",
      userId: "user-Bob Stone",
      role: "admin",
    });

    // Removing asks first.
    organizations.members.remove.mockResolvedValue({ ok: true });
    await act(async () => button("Remove")?.click());
    expect(container.querySelector("h2")?.textContent).toBe("Remove Bob Stone?");
    expect(organizations.members.remove).not.toHaveBeenCalled();
    const confirm = [...container.querySelectorAll("button")].filter(
      (each) => each.textContent === "Remove",
    );
    await act(async () => confirm.at(-1)?.click());
    await act(flush);
    expect(organizations.members.remove).toHaveBeenCalledWith({
      organizationId: "org-work",
      userId: "user-Bob Stone",
    });
  });

  it("shows the list without controls to someone who cannot manage it", async () => {
    organizations.list.mockResolvedValue(organization(2, "member"));
    organizations.members.list.mockResolvedValue({
      canManage: false,
      members: [person("Ada Lovelace", "owner", false), person("Bob Stone", "member", false)],
      invitations: [],
    });
    await render();
    await act(async () => button("Members2")?.click());
    await act(flush);
    expect(rows()).toEqual(["AAda LovelaceOwnerada@example.test", "BBob Stonebob@example.test"]);
    expect(container.querySelector('input[type="email"]')).toBeNull();
  });
});
