import type { ProviderSettingsField } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  initialSettingsValues,
  keepsSavedSecrets,
  settingsFieldProblem,
  settingsFieldValue,
  settingsSubmission,
  visibleSettingsFields,
} from "./provider-settings-form.js";

const key = (mode: string, required: boolean): ProviderSettingsField => ({
  key: "key",
  label: "Key",
  kind: "secret",
  required,
  minLength: 8,
  visibleWhen: { key: "mode", equals: mode },
});

const fields: ProviderSettingsField[] = [
  key("cloud", true),
  key("local", false),
  {
    key: "mode",
    label: "Connection",
    kind: "select",
    required: true,
    default: "cloud",
    options: [
      { value: "cloud", label: "Cloud" },
      { value: "local", label: "Self-hosted" },
    ],
    scopesSecrets: true,
  },
  {
    key: "address",
    label: "Address",
    kind: "url",
    required: true,
    visibleWhen: { key: "mode", equals: "local" },
    scopesSecrets: true,
  },
  {
    key: "team",
    label: "Team",
    kind: "text",
    required: false,
    maxLength: 12,
    checks: [
      { pattern: "^[a-z-]+$", message: "Lowercase letters only." },
      { pattern: "^(?!own-)", message: "own- is reserved." },
    ],
    scopesSecrets: true,
  },
  { key: "member", label: "Member", kind: "text", required: false, visibleWhen: { key: "team" } },
  { key: "sources", label: "Sources", kind: "list", required: false, scopesSecrets: true },
  { key: "learn", label: "Learn", kind: "toggle", required: true, default: "true" },
  {
    key: "name",
    label: "Name",
    kind: "text",
    required: true,
    requiredMessage: "A name is required.",
  },
];
const field = (name: string, at = 0) => fields.filter((entry) => entry.key === name)[at]!;
const keys = (shown: ProviderSettingsField[]) => shown.map((entry) => entry.key);

describe("provider settings form", () => {
  it("shows a field only while the field it depends on calls for it", () => {
    expect(keys(visibleSettingsFields(fields, {}))).toEqual([
      "key",
      "mode",
      "team",
      "sources",
      "learn",
      "name",
    ]);
    const local = visibleSettingsFields(fields, { mode: "local", team: " a " });
    expect(keys(local)).toEqual([
      "key",
      "mode",
      "address",
      "team",
      "member",
      "sources",
      "learn",
      "name",
    ]);
    // The same key, in the variant its mode calls for.
    expect(local[0]).toBe(field("key", 1));
    expect(keys(visibleSettingsFields(fields, { team: "   " }))).not.toContain("member");
  });

  it("reads each kind as it is saved", () => {
    expect(settingsFieldValue(field("team"), { team: "  ops  " })).toBe("ops");
    expect(settingsFieldValue(field("mode"), {})).toBe("cloud");
    expect(settingsFieldValue(field("mode"), { mode: "elsewhere" })).toBe("cloud");
    expect(settingsFieldValue(field("mode"), { mode: "local" })).toBe("local");
    expect(settingsFieldValue(field("learn"), {})).toBe("true");
    expect(settingsFieldValue(field("learn"), { learn: "false" })).toBe("false");
    expect(settingsFieldValue(field("sources"), { sources: " a, ,b ,a" })).toBe("a,b,a");
  });

  it("starts from saved settings, defaults, and empty secrets", () => {
    expect(initialSettingsValues(fields)).toEqual({
      mode: "cloud",
      address: "",
      team: "",
      member: "",
      sources: "",
      learn: "true",
      name: "",
    });
    expect(
      initialSettingsValues(fields, {
        // A hosted connection may store the service's own address, which is not one to edit.
        address: "https://hosted.example.test",
        key: "never-sent-back",
        team: "ops",
        member: "sam",
        learn: "false",
      }),
    ).toEqual({
      mode: "cloud",
      address: "",
      team: "ops",
      member: "sam",
      sources: "",
      learn: "false",
      name: "",
    });
    expect(
      initialSettingsValues(fields, { mode: "local", address: "http://10.0.0.8:6767" }).address,
    ).toBe("http://10.0.0.8:6767");
  });

  it("reports what stops a field being saved", () => {
    expect(settingsFieldProblem(field("team"), { team: "" })).toBeNull();
    expect(settingsFieldProblem(field("team"), { team: "Ops" })).toEqual({
      rule: "check",
      message: "Lowercase letters only.",
    });
    expect(settingsFieldProblem(field("team"), { team: "own-notes" })).toEqual({
      rule: "check",
      message: "own- is reserved.",
    });
    expect(settingsFieldProblem(field("team"), { team: "a-very-long-team" })).toEqual({
      rule: "length",
    });
    expect(settingsFieldProblem(field("address"), { address: " " })).toEqual({ rule: "required" });
    expect(settingsFieldProblem(field("name"), {})).toEqual({
      rule: "required",
      message: "A name is required.",
    });
    expect(settingsFieldProblem(field("mode"), { mode: "elsewhere" })).toEqual({ rule: "choice" });
    expect(settingsFieldProblem(field("mode"), {})).toBeNull();
    expect(settingsFieldProblem(field("learn"), { learn: "yes" })).toEqual({ rule: "choice" });
  });

  it("asks for a required secret unless the saved one is kept", () => {
    const required = field("key", 0);
    const optional = field("key", 1);
    expect(settingsFieldProblem(required, {})).toEqual({ rule: "required" });
    expect(settingsFieldProblem(required, {}, true)).toBeNull();
    expect(settingsFieldProblem(optional, {})).toBeNull();
    expect(settingsFieldProblem(required, { key: "short" }, true)).toEqual({ rule: "length" });
    expect(settingsFieldProblem(optional, { key: "short" })).toEqual({ rule: "length" });
    expect(settingsFieldProblem(required, { key: " long-enough " })).toBeNull();
  });

  it("keeps saved secrets only while nothing they reach has changed", () => {
    const saved = { mode: "local", address: "https://memory.example.test", sources: "a,b" };
    const draft = initialSettingsValues(fields, saved);
    expect(keepsSavedSecrets(fields, draft, undefined)).toBe(false);
    expect(keepsSavedSecrets(fields, draft, saved)).toBe(true);
    // Fields that scope no secret, a trailing slash, and the order of a list change nothing.
    expect(
      keepsSavedSecrets(
        fields,
        {
          ...draft,
          address: " https://memory.example.test// ",
          sources: "b, a,a",
          learn: "false",
          member: "sam",
        },
        saved,
      ),
    ).toBe(true);
    expect(keepsSavedSecrets(fields, { ...draft, sources: "a,b,c" }, saved)).toBe(false);
    expect(keepsSavedSecrets(fields, { ...draft, team: "ops" }, saved)).toBe(false);
    expect(
      keepsSavedSecrets(fields, { ...draft, address: "https://other.example.test" }, saved),
    ).toBe(false);
    expect(keepsSavedSecrets(fields, { ...draft, mode: "cloud" }, saved)).toBe(false);
    // A hosted connection's stored address is not what its secret is bound to.
    const hosted = { mode: "cloud", address: "https://hosted.example.test" };
    expect(keepsSavedSecrets(fields, initialSettingsValues(fields, hosted), hosted)).toBe(true);
  });

  it("sends the visible fields that hold a value, secrets apart", () => {
    expect(
      settingsSubmission(fields, {
        mode: "cloud",
        address: "http://10.0.0.8:6767",
        key: " hosted-key ",
        team: "",
        member: "sam",
        sources: " a, b ",
        learn: "false",
        name: " Notes ",
      }),
    ).toEqual({
      settings: { mode: "cloud", sources: "a,b", learn: "false", name: "Notes" },
      credentials: { key: "hosted-key" },
    });
    expect(
      settingsSubmission(fields, {
        mode: "local",
        address: " http://10.0.0.8:6767/ ",
        team: "ops",
      }),
    ).toEqual({
      settings: {
        mode: "local",
        address: "http://10.0.0.8:6767/",
        team: "ops",
        learn: "true",
      },
      credentials: {},
    });
  });
});
