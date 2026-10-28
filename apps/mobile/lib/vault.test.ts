import { decodeLoginSecret } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";

vi.mock("./i18n", () => ({ t: (text: string) => text }));

import type { CredentialDraft } from "./vault";
import {
  credentialDetail,
  credentialNameProblem,
  credentialValue,
  draftDestination,
  draftReady,
  EMPTY_DRAFT,
  readableCredential,
  secretReady,
  withCredential,
} from "./vault";

const draft = (change: Partial<CredentialDraft>): CredentialDraft => ({
  ...EMPTY_DRAFT,
  ...change,
});
const saved = (change: Record<string, unknown>) => ({
  name: "github",
  origin: "https://api.github.com",
  auth: { type: "bearer" as const },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...change,
});
const secret = { value: "example-value", fields: [] };
const loginFields = [
  { label: "Username", value: " ada ", hidden: false },
  { label: "Password", value: "example-password", hidden: true },
];

describe("vault credentials", () => {
  it("shows a site, a login's host, or the variable a command receives", () => {
    expect(credentialDetail(saved({}))).toBe("https://api.github.com");
    expect(
      credentialDetail(saved({ origin: "https://login.example.test", auth: { type: "login" } })),
    ).toBe("login.example.test");
    expect(
      credentialDetail(saved({ name: "netbird-key", origin: "", auth: { type: "command" } })),
    ).toBe("Command variable $NETBIRD_KEY");
    expect(credentialDetail(saved({ auth: null }))).toBe("https://api.github.com");
  });

  it("only replaces a credential whose settings and name still read", () => {
    expect(readableCredential(saved({}))).not.toBeNull();
    expect(readableCredential(saved({ auth: null }))).toBeNull();
    expect(readableCredential(saved({ name: "Old Name" }))).toBeNull();
  });

  it("reports a bad name or a reserved command variable once there is a name", () => {
    expect(credentialNameProblem(draft({ name: "" }))).toBeUndefined();
    expect(credentialNameProblem(draft({ name: "my key" }))).toBe("invalid");
    expect(credentialNameProblem(draft({ name: "path", type: "command" }))).toBe("reserved");
    expect(credentialNameProblem(draft({ name: "path" }))).toBeUndefined();
  });

  it("needs a site except for a command variable, and each type's own field", () => {
    expect(draftReady(draft({ name: "github" }), secret)).toBe(false);
    expect(draftReady(draft({ name: "github", origin: "https://api.github.com" }), secret)).toBe(
      true,
    );
    expect(draftReady(draft({ name: "netbird-key", type: "command" }), secret)).toBe(true);
    const header = draft({ name: "api", origin: "https://api.example.test", type: "header" });
    expect(draftReady(header, secret)).toBe(false);
    expect(draftReady({ ...header, headerName: "X-Api-Key" }, secret)).toBe(true);
    const login = draft({ name: "site", origin: "https://example.test", type: "login" });
    expect(draftReady(login, secret)).toBe(false);
    expect(draftReady(login, { value: "", fields: loginFields })).toBe(true);
  });

  it("needs every login field named, filled and named differently", () => {
    const ready = (fields: typeof loginFields) => secretReady("login", { value: "", fields });
    const [username, password] = loginFields;
    expect(ready(loginFields)).toBe(true);
    expect(ready([{ ...username!, label: " " }, password!])).toBe(false);
    expect(ready([{ ...username!, value: "  " }, password!])).toBe(false);
    expect(ready([username!, { ...password!, value: "" }])).toBe(false);
    expect(ready([username!, { ...password!, label: " username " }])).toBe(false);
    expect(ready([])).toBe(false);
  });

  it("sends no site for a command variable and trims the rest", () => {
    expect(
      draftDestination(draft({ name: " netbird-key ", type: "command", origin: "x" })),
    ).toEqual({ name: "netbird-key", auth: { type: "command" } });
    expect(
      draftDestination(
        draft({
          name: "api",
          origin: " https://api.example.test ",
          type: "header",
          headerName: " X-Api-Key ",
        }),
      ),
    ).toEqual({
      name: "api",
      origin: "https://api.example.test",
      auth: { type: "header", name: "X-Api-Key" },
    });
  });

  it("saves a website login as its encoded fields", () => {
    expect(credentialValue("bearer", { value: " token ", fields: [] })).toBe(" token ");
    expect(
      decodeLoginSecret(
        credentialValue("login", {
          value: "",
          fields: loginFields.map((field, id) => ({ ...field, id })),
        }),
      ),
    ).toEqual({
      fields: [
        { label: "Username", value: "ada", hidden: false },
        { label: "Password", value: "example-password", hidden: true },
      ],
    });
  });

  it("replaces a saved credential with the same name or adds it", () => {
    const list = [saved({}), saved({ name: "other" })];
    const replaced = saved({ updatedAt: "2026-02-01T00:00:00.000Z" });
    expect(withCredential(list, replaced)).toEqual([replaced, list[1]]);
    expect(withCredential(list, saved({ name: "new" })).map((entry) => entry.name)).toEqual([
      "github",
      "other",
      "new",
    ]);
  });
});
