import { expect, it } from "vitest";
import {
  appConnectCallbackUrl,
  appConnectReturn,
  isAppConnectCallbackPath,
} from "./app-connect-return.js";

it("keeps the connection in the path, leaving the query to the provider", () => {
  const web = new URL(appConnectCallbackUrl("https://app.test", "conn-1", undefined));
  const mobile = new URL(appConnectCallbackUrl("https://app.test", "conn-1", "mobile"));
  expect(web.search).toBe("");
  expect(isAppConnectCallbackPath(web.pathname)).toBe(true);
  expect(appConnectReturn(web.pathname)).toEqual({ connectionId: "conn-1", appUrl: null });
  expect(appConnectReturn(mobile.pathname)).toEqual({
    connectionId: "conn-1",
    appUrl: "rakazo://app-connect?connection=conn-1",
  });
});

it("reads an older callback with no connection as nothing to finish", () => {
  expect(isAppConnectCallbackPath("/integrations/callback")).toBe(true);
  expect(appConnectReturn("/integrations/callback")).toEqual({ connectionId: null, appUrl: null });
  expect(isAppConnectCallbackPath("/integrations/callbacks")).toBe(false);
});
