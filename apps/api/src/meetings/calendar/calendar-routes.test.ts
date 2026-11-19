import type { MeetingCalendarService } from "@rakazo/adapters";
import {
  MEETING_CALENDAR_CALLBACK_PATH,
  MOBILE_MEETING_CALENDAR_CALLBACK_URL,
} from "@rakazo/contracts";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { mountMeetingCalendarHttp } from "./calendar-routes.js";

const state = "mobile-fixture-state";

function fixture() {
  const app = new Hono();
  mountMeetingCalendarHttp(app, {} as MeetingCalendarService, async () => null);
  return (params: URLSearchParams) => app.request(`${MEETING_CALENDAR_CALLBACK_PATH}?${params}`);
}

describe("mobile calendar authorization callback", () => {
  it.each([
    ["access_denied", "denied"],
    ["temporarily_unavailable", "unavailable"],
    ["server_error", "unavailable"],
    ["invalid_request", "failed"],
    [undefined, "failed"],
  ])("returns the app outcome for provider error %s", async (upstream, outcome) => {
    const params = new URLSearchParams({ state });
    if (upstream) {
      params.set("error", upstream);
      params.set("code", "unused-fixture-code");
    }
    const response = await fixture()(params);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      `${MOBILE_MEETING_CALENDAR_CALLBACK_URL}?state=${state}&error=${outcome}`,
    );
  });

  it("retains the state and code on success", async () => {
    const params = new URLSearchParams({ state, code: "fixture-code" });
    const response = await fixture()(params);
    expect(response.headers.get("location")).toBe(
      `${MOBILE_MEETING_CALENDAR_CALLBACK_URL}?${params}`,
    );
  });

  it("rejects an ambiguous state", async () => {
    const params = new URLSearchParams({ state, code: "fixture-code" });
    params.append("state", "mobile-other-state");
    expect((await fixture()(params)).status).toBe(400);
  });
});
