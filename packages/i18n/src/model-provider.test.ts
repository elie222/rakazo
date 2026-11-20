import { i18n } from "@lingui/core";
import { connectedBackupOptions, providerDisplayName } from "@rakazo/contracts";
import { botModelState, connectedModelChoices } from "@rakazo/core";
import { afterEach, expect, it } from "vitest";
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
