import { i18n } from "@lingui/core";
import { afterEach, expect, it } from "vitest";
import { connectedBackupOptions, providerDisplayName } from "./model-provider";

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
  expect(providerDisplayName(entry, "oauth")).toBe("Example Abonnement");
  expect(providerDisplayName(entry, "api_key")).toBe("Example");
  const [option] = connectedBackupOptions(
    [entry],
    [
      {
        id: "credential",
        provider: "example",
        label: "Example",
        hasKey: true,
        isDefault: true,
        authKind: "oauth",
      },
    ],
  );
  expect(option).toMatchObject({
    providerName: "Example Abonnement",
    connectionName: "Example Abonnement",
  });
  expect(
    providerDisplayName({ ...entry, subscriptionName: "Untranslated subscription" }, "oauth"),
  ).toBe("Untranslated subscription");
});
