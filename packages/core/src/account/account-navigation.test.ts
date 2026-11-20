import { modelAccountConfigSchema } from "@rakazo/contracts";
import { expect, it } from "vitest";
import { resolveAccountNavigation } from "./account-navigation.js";

const defaults = {
  homeUrl: "https://home.example.test/",
  rechargeUrl: "https://wallet.example.test/wallet",
};
const channel = {
  channel: "partner",
  homeUrl: "https://partner.home.example.test/",
  rechargeUrl: "https://partner.wallet.example.test/wallet",
};
const config = modelAccountConfigSchema.parse({
  enabled: true,
  navigation: {
    cookieName: "one_nav",
    defaults,
    channels: [channel],
    productHosts: ["app.example.test"],
  },
});
const cookie = (value: unknown) => `one_nav=${encodeURIComponent(JSON.stringify(value))}`;
it("uses public defaults for native clients and absent or untrusted browser preferences", () => {
  expect(resolveAccountNavigation(config)).toEqual(defaults);
  expect(
    resolveAccountNavigation(
      config,
      cookie({ v: 1, ...channel, rechargeUrl: "https://evil.example.test/" }),
    ),
  ).toEqual(defaults);
  expect(resolveAccountNavigation(config, "one_nav=invalid")).toEqual(defaults);
  expect(resolveAccountNavigation({ enabled: false })).toBeUndefined();
});
it("accepts only exact platform-published channel destinations and isolates dedicated hosts", () => {
  expect(
    resolveAccountNavigation(config, cookie({ v: 1, ...channel }), "partner.app.example.test"),
  ).toEqual(channel);
  expect(
    resolveAccountNavigation(config, cookie({ v: 1, ...channel }), "other.app.example.test"),
  ).toBeUndefined();
  expect(resolveAccountNavigation(config, "", "partner.app.example.test")).toBeUndefined();
  expect(
    resolveAccountNavigation(
      config,
      cookie({ v: 1, ...channel }) + ";" + cookie({ v: 1, ...channel }),
    ),
  ).toEqual(defaults);
});
