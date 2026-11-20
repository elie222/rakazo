import { i18n } from "@lingui/core";
import {
  connectedBackupOptions,
  modelConnectionNames,
  providerDisplayName,
} from "@rakazo/contracts";
import { botModelState, connectedModelChoices } from "@rakazo/core";
import { afterEach, expect, it } from "vitest";
import { messages as germanMessages } from "../locales/de/messages.po";
import { localizeModelEntry } from "./model-provider";

afterEach(() => i18n.activate("en"));

it("localizes descriptor subscription names and leaves API names alone", () => {
  i18n.load("de", { "Example subscription": "Example Abonnement" });
  i18n.activate("de");
  const entry = {
    provider: "example",
    providerName: "Example",
    subscriptionName: "Example subscription",
    auth: "both" as const,
    id: "model",
    label: "Model",
    billing: "",
  };
  expect(providerDisplayName(localizeModelEntry(entry), "oauth")).toBe("Example Abonnement");
  expect(providerDisplayName(localizeModelEntry(entry), "api_key")).toBe("Example");
  const [option] = connectedBackupOptions([entry].map(localizeModelEntry), [
    {
      id: "credential",
      provider: "example",
      label: "Example",
      hasKey: true,
      isDefault: true,
      authKind: "oauth",
    },
  ]);
  expect(option).toMatchObject({
    providerName: "Example Abonnement",
    connectionName: "Example Abonnement",
  });
  expect(
    providerDisplayName(
      localizeModelEntry({ ...entry, subscriptionName: "Untranslated subscription" }),
      "oauth",
    ),
  ).toBe("Untranslated subscription");
});

it("refreshes subscription names and chat choices when the language changes", () => {
  const entry = {
    provider: "example",
    providerName: "Example",
    subscriptionName: "Example subscription",
    auth: "both" as const,
    id: "model",
    label: "Model",
    billing: "",
  };
  const credentials = [
    {
      id: "credential",
      hasKey: true,
      isDefault: true,
      provider: "example",
      label: "Example",
      authKind: "oauth" as const,
    },
  ];
  i18n.load("en", { "Example subscription": "Example subscription" });
  i18n.load("de", { "Example subscription": "Example Abonnement" });
  for (const [locale, expected] of [
    ["en", "Example subscription"],
    ["de", "Example Abonnement"],
    ["en", "Example subscription"],
  ]) {
    i18n.activate(locale!);
    expect(providerDisplayName(localizeModelEntry(entry), "oauth")).toBe(expected);
    expect(
      connectedModelChoices(
        [{ ...credentials[0]!, enabledModelIds: ["custom"] }],
        [entry].map(localizeModelEntry),
      )[0],
    ).toMatchObject({ providerLabel: expected, label: `custom (${expected})` });
    expect(
      botModelState({
        credentials,
        catalog: [entry].map(localizeModelEntry),
        me: null,
        modelKey: "example::model",
        spaceDefaultLabel: "Default",
      }).choices.find((choice) => choice.key === "example::model"),
    ).toMatchObject({ label: `Model (${expected})` });
    expect(connectedModelChoices(credentials, [entry].map(localizeModelEntry))[0]).toMatchObject({
      providerLabel: expected,
      label: `Model (${expected})`,
    });
    expect(
      connectedModelChoices(
        [{ ...credentials[0]!, authKind: "api_key" }],
        [entry].map(localizeModelEntry),
      )[0],
    ).toMatchObject({ providerLabel: "Example", label: "Model (Example)" });
  }
});

it("labels chat choices by the serving credential regardless of list order", () => {
  i18n.load("en", { "Example subscription": "Example subscription" });
  i18n.activate("en");
  const entry = {
    provider: "example",
    providerName: "Example",
    subscriptionName: "Example subscription",
    auth: "both" as const,
    id: "model",
    label: "Model",
    billing: "",
  };
  const oauth = {
    id: "oauth",
    provider: "example",
    label: "Example",
    authKind: "oauth",
    preferenceRank: 1,
  };
  const key = {
    id: "key",
    provider: "example",
    label: "Example",
    authKind: "api_key",
    preferenceRank: 0,
    modelId: "model",
  };
  for (const credentials of [
    [oauth, key],
    [key, oauth],
  ]) {
    expect(
      connectedModelChoices(
        credentials.map((credential) => ({ ...credential, modelId: "model" })),
        [entry].map(localizeModelEntry),
      )[0],
    ).toMatchObject({ providerLabel: "Example", label: "Model (Example)" });
    expect(connectedModelChoices(credentials, [entry].map(localizeModelEntry))[0]).toMatchObject({
      providerLabel: "Example",
      label: "Model (Example)",
    });
    expect(
      connectedModelChoices(
        credentials.map((credential) => ({
          ...credential,
          modelId: credential.id === "oauth" ? "model" : undefined,
        })),
        [entry].map(localizeModelEntry),
      )[0],
    ).toMatchObject({
      providerLabel: "Example subscription",
      label: "Model (Example subscription)",
    });
  }
});

it("uses existing generated ids in the real compiled German catalog", () => {
  i18n.load("de", germanMessages);
  i18n.activate("de");
  for (const [subscriptionName, subscriptionNameId, expected] of [
    ["Claude subscription", "oCbawp", "Claude-Abonnement"],
    ["ChatGPT subscription", "XrwIDk", "ChatGPT-Abonnement"],
  ]) {
    const entry = {
      provider: "example",
      providerName: "Example",
      subscriptionName,
      subscriptionNameId,
      auth: "both" as const,
    };
    expect(providerDisplayName(localizeModelEntry(entry), "oauth")).toBe(expected);
    expect(providerDisplayName(localizeModelEntry(entry), "api_key")).toBe("Example");
  }
});

it("keeps custom connection labels for enabled catalog models", () => {
  const entry = {
    provider: "example",
    providerName: "Example",
    subscriptionName: "Example subscription",
    auth: "both" as const,
    id: "model",
    label: "Model",
    billing: "",
  };
  const credential = {
    id: "work",
    provider: "example",
    label: "Work",
    authKind: "oauth",
    enabledModelIds: ["model"],
  };
  expect(connectedModelChoices([credential], [entry])[0]?.providerLabel).toBe(
    "Example subscription (Work)",
  );
});

it("leaves managed choices neutral while naming the member's own subscription", () => {
  const entry = {
    provider: "example",
    providerName: "Example",
    subscriptionName: "Example subscription",
    auth: "both" as const,
    id: "funded",
    label: "Funded model",
    billing: "",
    managed: true,
  };
  const credential = {
    id: "personal",
    provider: "example",
    label: "Personal",
    authKind: "oauth",
    enabledModelIds: ["own"],
  };
  const choices = connectedModelChoices([credential], [entry]);
  expect(choices.find((choice) => choice.modelId === "funded")).toMatchObject({
    providerLabel: "Example",
    label: "Funded model (Example)",
  });
  expect(choices.find((choice) => choice.modelId === "own")).toMatchObject({
    providerLabel: "Example subscription (Personal)",
  });
  const overlapping = connectedModelChoices(
    [{ ...credential, enabledModelIds: ["funded"] }],
    [entry],
  );
  expect(overlapping).toHaveLength(1);
  expect(overlapping[0]?.providerLabel).toBe("Example subscription (Personal)");
});

it("keeps managed OAuth-only role names neutral until a sign-in is explicit", () => {
  const entry = {
    provider: "example",
    providerName: "Example",
    subscriptionName: "Example subscription",
    auth: "oauth" as const,
    managed: true,
    id: "model",
    label: "Model",
    billing: "",
  };
  expect(modelConnectionNames(localizeModelEntry(entry)).providerName).toBe("Example");
  expect(providerDisplayName(localizeModelEntry(entry))).toBe("Example subscription");
  expect(connectedBackupOptions([entry], [])[0]).toMatchObject({
    providerName: "Example",
    connectionName: "Example",
  });
  expect(providerDisplayName(localizeModelEntry(entry), "sign-in")).toBe("Example subscription");
  const credential = {
    id: "signed-in",
    provider: "example",
    label: "Example",
    hasKey: true,
    isDefault: true,
    authKind: "oauth" as const,
  };
  expect(connectedBackupOptions([entry], [credential])[0]).toMatchObject({
    providerName: "Example subscription",
    connectionName: "Example subscription",
  });
});
