import type { OrganizationList } from "@rakazo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Organization } from "./organizations";
import {
  leaveDeletedOrganization,
  organizationLanding,
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
vi.mock("./api", () => ({
  adoptDeletedSpaceFallback: vi.fn(async () => true),
  captureApiRequestContext: async () => ({ apiBase: "https://app.example.test", headers: {} }),
  currentApiBase: () => "https://app.example.test",
  loadOrganizationSpaces: async () => state.remembered,
  rememberOrganizationSpace: vi.fn(async (organizationId: string, spaceId: string) => {
    state.remembered = { ...state.remembered, [organizationId]: spaceId };
  }),
  rpc: state.rpc,
  selectedSpaceId: () => state.selected,
  selectSpace: state.selectSpace,
}));
vi.mock("./session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("./i18n", () => ({ t: (text: string) => text }));

const work: Organization = {
  id: "org-work",
  name: "Work",
  defaultSpaceId: "space-a1",
  spaceIds: ["space-a1", "space-a2"],
};
const home: Organization = {
  id: "org-home",
  name: "Home",
  defaultSpaceId: "space-b1",
  spaceIds: ["space-b1", "space-b2"],
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

describe("organizationLanding", () => {
  it("opens the Space last used there, else the default", () => {
    expect(organizationLanding(home, { "org-home": "space-b2" })).toBe("space-b2");
    expect(organizationLanding(home, { "org-home": "space-deleted" })).toBe("space-b1");
    expect(organizationLanding(home, {})).toBe("space-b1");
  });
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
});

it("opens the Space the server chose after deleting an organization", async () => {
  seed("space-a1");
  seed("space-b1");
  await expect(leaveDeletedOrganization(work, "space-b1")).resolves.toBe(true);
  expect(state.selectSpace).toHaveBeenCalledWith("space-b1");
  expect(cachedSpaces()).toEqual(["space:space-b1"]);
  expect(state.router.replace).toHaveBeenCalledWith("/");
});

describe("organizationSwitchActions", () => {
  it("lists organizations only once there is a second, checking the active one", () => {
    expect(
      organizationSwitchActions({ activeOrganizationId: work.id, organizations: [work] }),
    ).toEqual([]);
    expect(organizationSwitchActions(undefined)).toEqual([]);
    expect(
      organizationSwitchActions({ activeOrganizationId: home.id, organizations: [work, home] }),
    ).toEqual([
      { id: "organization:org-work", title: "Work", state: "off" },
      { id: "organization:org-home", title: "Home", state: "on" },
    ]);
  });
});
