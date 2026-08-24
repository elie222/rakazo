import { describe, expect, it } from "vitest";
import {
  accountDefaultSelector,
  accountsForExternalId,
  accountsFromConnections,
  addAccountParameter,
  resolveConnectorAccount,
  stripAccountArg,
} from "./connector-accounts.js";

const accounts = [
  { externalId: "gmail", id: "apn_personal", alias: "personal" },
  { externalId: "gmail", id: "apn_work", alias: "work" },
  { externalId: "linear", id: "apn_linear", alias: "work-linear" },
];

describe("connector account selection", () => {
  it("maps connection rows to account refs and skips legacy app-slug refs", () => {
    expect(
      accountsFromConnections([
        { externalId: "GMAIL", providerRef: "apn_personal", displayName: "Personal" },
        { externalId: "gmail", providerRef: "apn_work", displayName: "Work" },
        { externalId: "GMAIL", providerRef: "GMAIL", displayName: "Legacy" },
        { externalId: "GMAIL", providerRef: null, displayName: "Missing" },
      ]),
    ).toEqual([
      { externalId: "gmail", id: "apn_personal", alias: "Personal" },
      { externalId: "gmail", id: "apn_work", alias: "Work" },
    ]);
  });

  it("resolves aliases and ids only within one app", () => {
    expect(resolveConnectorAccount(accounts, "gmail", "work")).toEqual(accounts[1]);
    expect(resolveConnectorAccount(accounts, "gmail", "apn_personal")).toEqual(accounts[0]);
    expect(resolveConnectorAccount(accounts, "linear", "personal")).toBeUndefined();
  });

  it("uses connector-scoped defaults and stays silent when multiple accounts are ambiguous", () => {
    expect(
      accountDefaultSelector({ "pipedream:gmail": "apn_work", "composio:GMAIL": "ca_x" }, "pipedream", "Gmail"),
    ).toBe("apn_work");
    expect(resolveConnectorAccount(accounts, "gmail", undefined, "work")).toEqual(accounts[1]);
    expect(resolveConnectorAccount(accounts, "gmail")).toBeUndefined();
    expect(accountsForExternalId(accounts, "GMAIL")).toEqual([accounts[0], accounts[1]]);
  });

  it("adds an optional account selector when a default exists", () => {
    expect(
      addAccountParameter(
        { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        accountsForExternalId(accounts, "gmail"),
        "work",
      ),
    ).toEqual({
      type: "object",
      properties: {
        text: { type: "string" },
        account: {
          type: "string",
          enum: ["personal", "work"],
          description: "Account alias. Uses bot default if omitted.",
        },
      },
      required: ["text"],
    });
  });

  it("strips the account selector before provider execution", () => {
    expect(stripAccountArg({ account: "Work", text: "hi" })).toEqual({
      account: "Work",
      args: { text: "hi" },
    });
    expect(stripAccountArg({ text: "hi" })).toEqual({ args: { text: "hi" } });
  });
});
