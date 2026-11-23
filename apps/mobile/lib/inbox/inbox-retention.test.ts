import { describe, expect, it } from "vitest";
import { retainInboxValue } from "./inbox-retention";

const snapshot = () => ({
  spaces: [
    {
      id: "space-1",
      bots: [
        { id: "bot-1", status: "idle", unread: false, tools: ["shell"] },
        { id: "bot-2", status: "idle", unread: false, tools: [] },
      ],
      groups: [{ id: "group-1", members: [{ id: "bot-1", name: "Helper" }] }],
      botSections: [{ id: "section-1", name: "Work" }],
    },
  ],
  me: { spaceId: "space-1", name: "Example", preferences: { avatar: "flat" } },
});

describe("inbox response retention", () => {
  it("retains the entire unchanged nested response and ignores object key order", () => {
    const current = snapshot();
    const next = structuredClone(current);
    next.me = { preferences: next.me.preferences, name: next.me.name, spaceId: next.me.spaceId };
    expect(retainInboxValue(current, next)).toBe(current);
    const empty: unknown[] = [];
    expect(retainInboxValue(empty, [])).toBe(empty);
  });

  it("updates a changed row while retaining other rows and response branches", () => {
    const current = snapshot();
    const next = snapshot();
    next.spaces[0]!.bots[0]!.status = "running";
    next.spaces[0]!.bots[0]!.unread = true;
    const retained = retainInboxValue(current, next);
    expect(retained.spaces[0]!.bots[0]).toEqual(next.spaces[0]!.bots[0]);
    expect(retained.spaces[0]!.bots[0]).not.toBe(current.spaces[0]!.bots[0]);
    expect(retained.spaces[0]!.bots[1]).toBe(current.spaces[0]!.bots[1]);
    expect(retained.spaces[0]!.groups).toBe(current.spaces[0]!.groups);
    expect(retained.me).toBe(current.me);
  });

  it("applies nested member, section, preference and ordered primitive-array changes", () => {
    const current = snapshot();
    const next = snapshot();
    next.spaces[0]!.groups[0]!.members[0]!.name = "Renamed";
    next.spaces[0]!.botSections[0]!.name = "Other";
    next.spaces[0]!.bots[0]!.tools = ["web", "shell"];
    next.me.preferences.avatar = "image";
    const retained = retainInboxValue(current, next);
    expect(retained).toEqual(next);
    expect(retained.spaces[0]!.bots[1]).toBe(current.spaces[0]!.bots[1]);
    expect(retainInboxValue(["a", "b"], ["b", "a"])).toEqual(["b", "a"]);
  });

  it("preserves keyed rows across insertion, removal and reorder", () => {
    const current = snapshot().spaces[0]!.bots;
    const next = [
      structuredClone(current[1]!),
      { ...current[0]!, id: "bot-3" },
      structuredClone(current[0]!),
    ];
    const retained = retainInboxValue(current, next);
    expect(retained).toEqual(next);
    expect(retained[0]).toBe(current[1]);
    expect(retained[2]).toBe(current[0]);
    expect(retainInboxValue(current, [structuredClone(current[1]!)])[0]).toBe(current[1]);
    expect(retainInboxValue(current, [])).toEqual([]);
  });

  it("distinguishes removed fields, explicit undefined, null and added fields", () => {
    expect(retainInboxValue({ name: "Example", extra: undefined }, { name: "Example" })).toEqual({
      name: "Example",
    });
    const current: { name: string; extra?: unknown } = { name: "Example" };
    expect(retainInboxValue(current, { ...current, extra: undefined })).not.toBe(current);
    expect(retainInboxValue({ value: null }, { value: "present" })).toEqual({ value: "present" });
    expect(retainInboxValue(null, { spaceId: "space-2" })).not.toBeNull();
  });
});
