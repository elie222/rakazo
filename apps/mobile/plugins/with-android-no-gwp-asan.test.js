import { expect, it } from "vitest";
import { disableGwpAsan } from "./with-android-no-gwp-asan.js";

it("opts the app out of GWP-ASan sampling", () => {
  const manifest = { application: [{ $: { "android:name": ".MainApplication" } }] };
  expect(disableGwpAsan(manifest).application[0].$).toEqual({
    "android:name": ".MainApplication",
    "android:gwpAsanMode": "never",
  });
});

it("fails prebuild when the manifest has no application", () => {
  expect(() => disableGwpAsan({})).toThrow(/no <application>/);
});
