import { describe, expect, it } from "vitest";
import {
  canDeleteOrganization,
  canManageOrganizationMembers,
  organizationLandingSpaceId,
  organizationOfSpace,
} from "./organizations.js";

const work = {
  id: "org-work",
  name: "Work",
  defaultSpaceId: "a1",
  spaceIds: ["a1", "a2"],
  canManage: true,
  role: "owner" as const,
  memberCount: 1,
};
const home = {
  id: "org-home",
  name: "Home",
  defaultSpaceId: "b1",
  spaceIds: ["b1", "b2"],
  canManage: true,
  role: "owner" as const,
  memberCount: 1,
};

describe("organizationLandingSpaceId", () => {
  it("opens the Space last used there, else the default", () => {
    expect(organizationLandingSpaceId(home, { "org-home": "b2" })).toBe("b2");
    expect(organizationLandingSpaceId(home, { "org-home": "deleted" })).toBe("b1");
    expect(organizationLandingSpaceId(home, { "org-work": "a2" })).toBe("b1");
  });
});

describe("organizationOfSpace", () => {
  it("finds the organization holding the Space", () => {
    expect(organizationOfSpace([work, home], "b2")).toBe(home);
    expect(organizationOfSpace([work, home], "elsewhere")).toBeUndefined();
    expect(organizationOfSpace([work, home], null)).toBeUndefined();
  });
});

describe("canDeleteOrganization", () => {
  it("lets an owner delete one while they own another", () => {
    const joined = { ...home, id: "org-joined", canManage: false, role: "member" as const };
    expect(canDeleteOrganization([work, home], home)).toBe(true);
    expect(canDeleteOrganization([work, joined], work)).toBe(false);
    expect(canDeleteOrganization([work, home, joined], joined)).toBe(false);
  });

  it("keeps one other people belong to", () => {
    const team = { ...home, memberCount: 3 };
    expect(canDeleteOrganization([work, team], team)).toBe(false);
    expect(canDeleteOrganization([work, team], work)).toBe(true);
  });
});

describe("canManageOrganizationMembers", () => {
  it("is for the owner and admins", () => {
    expect(canManageOrganizationMembers(home)).toBe(true);
    expect(canManageOrganizationMembers({ ...home, role: "admin" })).toBe(true);
    expect(canManageOrganizationMembers({ ...home, role: "member" })).toBe(false);
  });
});
