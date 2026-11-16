import type { OrganizationList } from "@rakazo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { adoptDeletedSpaceFallback } from "./api-server";
import type { Organization } from "./organizations";
import {
  activeOrganization,
  ensureOrganizations,
  leaveDeletedOrganization,
  organizationSwitchActions,
  organizationSwitchEpoch,
  selectSpaceAcrossOrganizations,
  switchOrganization,
} from "./organizations";
import { queryClient } from "./query";

const state = vi.hoisted(() => ({
  selected: "space-a1" as string | null,
  remembered: {} as Record<string, string>,
  selectSpace: vi.fn(),
  rpc: vi.fn(),
  router: { canDismiss: vi.fn(() => false), dismissAll: vi.fn(), replace: vi.fn() },
}));

vi.mock("expo-router", () => ({ router: state.router }));
vi.mock("./api-server", () => ({
  adoptDeletedSpaceFallback: vi.fn(async () => true),
  loadOrganizationSpaces: async () => state.remembered,
  rememberOrganizationSpace: vi.fn(async (organizationId: string, spaceId: string) => {
    state.remembered = { ...state.remembered, [organizationId]: spaceId };
  }),
  selectSpace: state.selectSpace,
}));
vi.mock("./api-auth", () => ({}));
vi.mock("./api-live", () => ({}));
vi.mock("./api", () => ({
  captureApiRequestContext: async () => ({ apiBase: "https://app.example.test", headers: {} }),
  currentApiBase: () => "https://app.example.test",
  rpc: state.rpc,
  selectedSpaceId: () => state.selected,
}));
vi.mock("./session", () => ({ currentSessionGeneration: () => 1 }));

const work: Organization = {
  id: "org-work",
  name: "Work",
  defaultSpaceId: "space-a1",
  spaceIds: ["space-a1", "space-a2"],
  canManage: true,
};
const home: Organization = {
  id: "org-home",
  name: "Home",
  defaultSpaceId: "space-b1",
  spaceIds: ["space-b1", "space-b2"],
  canManage: true,
};

function seed(spaceId: string) {
  queryClient.setQueryData(
    ["server:https://app.example.test", "session:1", `space:${spaceId}`, "bots/list", {}],
    [],
  );
}

function cachedSpaces() {
  return queryClient
    .getQueryCache()
    .getAll()
    .map((query) => query.queryKey[2]);
}

function listKey(spaceId: string) {
  return [
    "server:https://app.example.test",
    "session:1",
    `space:${spaceId}`,
    "organizations/list",
    {},
  ];
}

beforeEach(() => {
  queryClient.clear();
  state.selected = "space-a1";
  state.remembered = {};
  state.rpc.mockReset();
  state.selectSpace.mockReset();
  state.selectSpace.mockImplementation(async (id: string) => {
    state.selected = id;
    return true;
  });
  state.router.replace.mockReset();
  state.router.dismissAll.mockReset();
});

describe("switchOrganization", () => {
  it("remembers where it left, lands on the saved Space and forgets the old organization", async () => {
    state.selected = "space-a2";
    state.remembered = { "org-home": "space-b2" };
    for (const id of ["space-a1", "space-a2", "space-b1"]) seed(id);
    const epoch = organizationSwitchEpoch();

    await expect(switchOrganization(home, [work, home])).resolves.toBe(true);

    expect(state.selectSpace).toHaveBeenCalledWith("space-b2");
    expect(state.remembered["org-work"]).toBe("space-a2");
    expect(cachedSpaces()).toEqual(["space:space-b1"]);
    expect(organizationSwitchEpoch()).toBe(epoch + 1);
    expect(state.router.replace).toHaveBeenCalledWith("/");
  });

  it("lets the last of two quick picks win", async () => {
    const third: Organization = {
      id: "org-side",
      name: "Side",
      defaultSpaceId: "space-c1",
      spaceIds: ["space-c1"],
      canManage: true,
    };
    let finishFirst: (() => void) | undefined;
    state.selectSpace.mockImplementationOnce(
      (id: string) =>
        new Promise<boolean>((resolve) => {
          finishFirst = () => {
            state.selected = id;
            resolve(true);
          };
        }),
    );

    const first = switchOrganization(home, [work, home, third]);
    const second = switchOrganization(third, [work, home, third]);
    await vi.waitFor(() => expect(finishFirst).toBeDefined());
    finishFirst?.();

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(state.selected).toBe("space-c1");
    expect(state.remembered["org-home"]).toBe("space-b1");
  });

  it("falls back to the default Space when the saved one was deleted", async () => {
    state.remembered = { "org-home": "space-gone" };
    await switchOrganization(home, [work, home]);
    expect(state.selectSpace).toHaveBeenCalledWith("space-b1");
  });

  it("keeps the cache and stays put when the selection cannot be saved", async () => {
    state.selectSpace.mockResolvedValue(false);
    seed("space-a1");
    await expect(switchOrganization(home, [work, home])).resolves.toBe(false);
    expect(cachedSpaces()).toEqual(["space:space-a1"]);
    expect(state.router.replace).not.toHaveBeenCalled();
  });

  it("does nothing for the organization already open", async () => {
    await expect(switchOrganization(work, [work, home])).resolves.toBe(true);
    expect(state.selectSpace).not.toHaveBeenCalled();
  });
});

describe("selectSpaceAcrossOrganizations", () => {
  const list: OrganizationList = { activeOrganizationId: work.id, organizations: [work, home] };

  it("switches organizations for a Space in another one", async () => {
    state.rpc.mockResolvedValue(list);
    seed("space-a1");
    await expect(selectSpaceAcrossOrganizations("space-b2")).resolves.toBe(true);
    expect(state.remembered["org-work"]).toBe("space-a1");
    expect(cachedSpaces()).not.toContain("space:space-a1");
    expect(state.router.replace).not.toHaveBeenCalled();
  });

  it("only selects a Space in the same organization", async () => {
    state.rpc.mockResolvedValue(list);
    const epoch = organizationSwitchEpoch();
    await selectSpaceAcrossOrganizations("space-a2");
    expect(state.selectSpace).toHaveBeenCalledWith("space-a2");
    expect(state.remembered).toEqual({});
    expect(organizationSwitchEpoch()).toBe(epoch);
  });

  it("still selects the Space on a server without organizations", async () => {
    state.rpc.mockRejectedValue(new Error("Not found"));
    await expect(selectSpaceAcrossOrganizations("space-b2")).resolves.toBe(true);
    expect(state.selectSpace).toHaveBeenCalledWith("space-b2");
  });

  it("remembers the left Space from the cached list when the fresh read fails", async () => {
    state.selected = "space-a2";
    queryClient.setQueryData(listKey("space-a2"), list);
    await queryClient.invalidateQueries({ queryKey: listKey("space-a2") });
    state.rpc.mockRejectedValueOnce(Object.assign(new Error("Bad gateway"), { status: 502 }));
    seed("space-a2");
    const epoch = organizationSwitchEpoch();

    await expect(selectSpaceAcrossOrganizations("space-b2")).resolves.toBe(true);

    expect(state.remembered["org-work"]).toBe("space-a2");
    expect(cachedSpaces()).toEqual([]);
    expect(organizationSwitchEpoch()).toBe(epoch + 1);
  });
});

it("opens the Space the server chose after deleting an organization", async () => {
  seed("space-a1");
  seed("space-b1");
  await leaveDeletedOrganization(work, "space-b1");
  expect(state.selectSpace).toHaveBeenCalledWith("space-b1");
  expect(cachedSpaces()).toEqual(["space:space-b1"]);
  expect(state.router.replace).toHaveBeenCalledWith("/");
});

it("stays on the settings screen when no Space can be selected after deleting", async () => {
  state.selectSpace.mockResolvedValue(false);
  vi.mocked(adoptDeletedSpaceFallback).mockResolvedValueOnce(false);
  seed("space-a1");
  const epoch = organizationSwitchEpoch();

  await expect(leaveDeletedOrganization(work, "space-b1")).rejects.toThrow();

  expect(cachedSpaces()).toEqual(["space:space-a1"]);
  expect(organizationSwitchEpoch()).toBe(epoch);
  expect(state.router.replace).not.toHaveBeenCalled();
});

describe("organizationSwitchActions", () => {
  it("lists organizations only once there is a second, checking the active one", () => {
    expect(
      organizationSwitchActions({ activeOrganizationId: work.id, organizations: [work] }),
    ).toEqual([]);
    expect(organizationSwitchActions(undefined)).toEqual([]);
    state.selected = "space-b2";
    expect(
      organizationSwitchActions({ activeOrganizationId: home.id, organizations: [work, home] }),
    ).toEqual([
      { id: "organization:org-work", title: "Work", state: "off" },
      { id: "organization:org-home", title: "Home", state: "on" },
    ]);
  });
});

describe("the organization list", () => {
  it("follows the selected Space when the server's answer has not caught up", () => {
    state.selected = "space-b1";
    expect(
      activeOrganization({ activeOrganizationId: work.id, organizations: [work, home] })?.id,
    ).toBe(home.id);
    state.selected = "space-new";
    expect(
      activeOrganization({ activeOrganizationId: work.id, organizations: [work, home] })?.id,
    ).toBe(work.id);
  });

  it("is asked for again after a switch, so a new organization shows at once", async () => {
    const before = { activeOrganizationId: home.id, organizations: [home] };
    queryClient.setQueryData(listKey("space-b1"), before);
    await switchOrganization(home, [work, home]);
    expect(queryClient.getQueryState(listKey("space-b1"))?.isInvalidated).toBe(true);
  });

  it("loads again on the next inbox load after a failed first try", async () => {
    state.rpc.mockRejectedValueOnce(Object.assign(new Error("Offline"), { status: 404 }));
    await ensureOrganizations();
    expect(queryClient.getQueryData(listKey("space-a1"))).toBeUndefined();
    const list = { activeOrganizationId: work.id, organizations: [work, home] };
    state.rpc.mockResolvedValueOnce(list);
    await ensureOrganizations();
    expect(queryClient.getQueryData(listKey("space-a1"))).toEqual(list);
  });
});
