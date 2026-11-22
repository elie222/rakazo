import { describe, expect, it } from "vitest";
import { mcpHeaderEditValid, mcpOAuthClientInput, mcpServerHeaders } from "./mcp-server-update.js";

const stored = ["X-Api-Key", "X-Team"];
const headers = (name: string, value: string, endpointChanged = false) =>
  mcpServerHeaders({ storedKeys: stored, name, value, endpointChanged });

describe("mcpServerHeaders", () => {
  it("sends stored headers blank to keep them", () => {
    expect(headers("X-Api-Key", "")).toEqual({ "X-Api-Key": "", "X-Team": "" });
  });

  it("replaces the edited header's value", () => {
    expect(headers("X-Api-Key", " new ")).toEqual({ "X-Api-Key": "new", "X-Team": "" });
  });

  it("moves the edited header to a new name only with a new value", () => {
    expect(headers("X-Key", "new")).toEqual({ "X-Key": "new", "X-Team": "" });
    expect(headers("X-Key", "")).toEqual({ "X-Api-Key": "", "X-Team": "" });
  });

  it("removes the edited header when its name is cleared", () => {
    expect(headers("", "")).toEqual({ "X-Team": "" });
  });

  it("puts a value typed without a name in Authorization", () => {
    expect(
      mcpServerHeaders({ storedKeys: [], name: "", value: "abc", endpointChanged: false }),
    ).toEqual({ Authorization: "abc" });
  });

  it("drops stored values when the URL changes", () => {
    expect(headers("X-Api-Key", "", true)).toEqual({});
    expect(headers("X-Api-Key", "new", true)).toEqual({ "X-Api-Key": "new" });
  });
});

describe("mcpHeaderEditValid", () => {
  it("asks for a value only when a stored header is renamed", () => {
    expect(mcpHeaderEditValid(stored, "X-Api-Key", "")).toBe(true);
    expect(mcpHeaderEditValid(stored, "X-Key", "")).toBe(false);
    expect(mcpHeaderEditValid(stored, "X-Key", "new")).toBe(true);
    expect(mcpHeaderEditValid(stored, "", "")).toBe(true);
    expect(mcpHeaderEditValid([], "X-Key", "")).toBe(true);
  });
});

describe("mcpOAuthClientInput", () => {
  it("sends the client only when an ID is entered", () => {
    expect(mcpOAuthClientInput({ clientId: " ", clientSecret: "s", scope: "", params: "" })).toBe(
      undefined,
    );
    expect(
      mcpOAuthClientInput({ clientId: " id ", clientSecret: "", scope: " read ", params: "" }),
    ).toEqual({
      clientId: "id",
      clientSecret: undefined,
      scope: "read",
      authorizationParams: undefined,
    });
  });
});
