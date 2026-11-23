import { describe, expect, it } from "vitest";
import {
  canDeleteOrganization,
  canManageOrganizationMembers,
  organizationLandingSpaceId,
  organizationOfSpace,
  spaceInvitee,
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

describe("spaceInvitee", () => {
  const person = (userId: string, email: string) => ({ userId, name: "", email, image: null });
  const list = {
    members: [{ ...person("u1", "ana@example.test"), role: "owner" as const }],
    addable: [person("u2", "Ben@Example.test")],
  };

  it("tells members, the organization's people and outsiders apart once it reads as an address", () => {
    for (const partial of [
      "ana@exam",
      "ana@exam.",
      "@example.test",
      "a@b@example.test",
      "a b@c.de",
      `${"a".repeat(250)}@b.cd`,
    ])
      expect(spaceInvitee(list, partial)).toBeNull();
    expect(spaceInvitee(list, " ANA@example.test ")).toEqual({ kind: "member" });
    expect(spaceInvitee(list, "ben@example.test")).toEqual({ kind: "addable", userId: "u2" });
    expect(spaceInvitee(list, "cy@example.test")).toEqual({ kind: "outside" });
    expect(spaceInvitee({ members: [] }, "ben@example.test")).toEqual({ kind: "outside" });
  });
});
