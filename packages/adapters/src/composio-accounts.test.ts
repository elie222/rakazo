import { describe, expect, it } from "vitest";
import {
  addComposioAccountParameter,
  buildComposioMultiAccountOptions,
  type ComposioAccountRef,
  composioAccountsFromConnections,
  resolveComposioAccount,
  stripComposioAccount,
} from "./composio-accounts.js";

const accounts: ComposioAccountRef[] = [
  { toolkit: "gmail", id: "ca_personal", alias: "personal", email: "shrage@gmail.com" },
  { toolkit: "gmail", id: "ca_work", alias: "work", email: "shrage@company.com" },
  { toolkit: "googlecalendar", id: "ca_calendar", alias: "personal-calendar" },
];

describe("Composio account selection", () => {
  it("enables multi-account mode and pins every known account to its toolkit", () => {
    expect(buildComposioMultiAccountOptions(accounts)).toEqual({
      multiAccount: {
        enable: true,
        maxAccountsPerToolkit: 5,
        requireExplicitSelection: true,
      },
      connectedAccounts: {
        gmail: ["ca_personal", "ca_work"],
        googlecalendar: ["ca_calendar"],
      },
    });
  });

  it("resolves an explicit alias or connected-account id only within the requested toolkit", () => {
    expect(resolveComposioAccount(accounts, "gmail", "work")).toEqual(accounts[1]);
    expect(resolveComposioAccount(accounts, "gmail", "ca_personal")).toEqual(accounts[0]);
    expect(resolveComposioAccount(accounts, "googlecalendar", "personal")).toBeUndefined();
  });

  it("uses a toolkit default when no explicit account was requested", () => {
    expect(resolveComposioAccount(accounts, "gmail", undefined, "work")).toEqual(accounts[1]);
    expect(resolveComposioAccount(accounts, "googlecalendar")).toEqual(accounts[2]);
  });

  it("does not silently choose between multiple accounts", () => {
    expect(resolveComposioAccount(accounts, "gmail")).toBeUndefined();
  });

  it("adds a safe account selector to a multi-account tool schema", () => {
    expect(
      addComposioAccountParameter(
        { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
        accounts.filter((account) => account.toolkit === "gmail"),
      ),
    ).toEqual({
      type: "object",
      properties: {
        to: { type: "string" },
        account: {
          type: "string",
          enum: ["personal", "work"],
          description: "Connected account alias. Required when more than one account is connected.",
        },
      },
      required: ["to", "account"],
    });
  });

  it("maps persisted connector rows to provider account refs without exposing rows without ids", () => {
    expect(
      composioAccountsFromConnections([
        { externalId: "GMAIL", providerRef: "ca_personal", displayName: "Personal" },
        { externalId: "gmail", providerRef: "ca_work", displayName: "Work" },
        { externalId: "GMAIL", providerRef: "GMAIL", displayName: "Legacy" },
        { externalId: "GMAIL", providerRef: null, displayName: "Legacy" },
      ]),
    ).toEqual([
      { toolkit: "gmail", id: "ca_personal", alias: "Personal" },
      { toolkit: "gmail", id: "ca_work", alias: "Work" },
    ]);
  });

  it("extracts the account selector before sending provider tool arguments", () => {
    expect(stripComposioAccount({ account: "Work", to: "hello@example.com" })).toEqual({
      account: "Work",
      args: { to: "hello@example.com" },
    });
    expect(stripComposioAccount({ to: "hello@example.com" })).toEqual({
      args: { to: "hello@example.com" },
    });
  });
});
