import { describe, expect, it } from "vitest";
import { Client, newLab } from "../test-utils.js";
import { flightsSite } from "./flights.js";
import { cheapestFlight, offersFor, repricedPrice } from "./flights-data.js";
import { inboxSite } from "./inbox.js";

describe("flights", () => {
  it("is deterministic and has a unique cheapest fare", () => {
    const a = offersFor("TLV", "ATH", "2026-12-14");
    expect(offersFor("TLV", "ATH", "2026-12-14")).toEqual(a);
    const prices = a.map((o) => o.pricePerPax);
    expect(new Set(prices).size).toBe(prices.length);
    expect(cheapestFlight("TLV", "ATH", "2026-12-14", 2).total).toBe(Math.min(...prices) * 2);
  });

  it("walks search -> seats -> passengers -> test payment -> reference, logging the payment", async () => {
    const lab = newLab();
    const c = new Client(flightsSite(lab));
    const best = offersFor("TLV", "ATH", "2026-12-14").find((o) => repricedPrice(o) === null)!;
    const results = await (await c.req("/results?from=TLV&to=ATH&date=2026-12-14&pax=1")).text();
    expect(results).toContain(best.id);
    const sel = await c.form("/select", { offer: best.id, pax: "1", route: "TLV>ATH" });
    const trip = sel.headers.get("location")!;
    expect(trip).toMatch(/^\/trip\/bk-/);
    expect((await c.req(`${trip}`)).headers.get("location")).toBe(`${trip}/seats`);
    await c.form(`${trip}/seats`, { skip: "1" });
    expect(
      (
        await c.form(`${trip}/passengers`, {
          first0: "Dana",
          last0: "Alon",
          passport0: "P1234567",
          dob0: "1990-01-01",
          email: "a@example.test",
          phone: "0555000101",
        })
      ).headers.get("location"),
    ).toBe(`${trip}/payment`);
    expect(lab.events.some((e) => e.type === "payment.submitted")).toBe(false);
    await c.form(`${trip}/payment`, {
      card: "4242 4242 4242 4242",
      holder: "D A",
      exp: "12/30",
      cvv: "123",
    });
    const conf = await (await c.req(`${trip}/confirmation`)).text();
    expect(conf).toMatch(/data-testid="booking-ref">SKY[A-Z0-9]+/);
    expect(conf).toContain("לא בוצע חיוב");
    const pay = lab.events.filter((e) => e.type === "payment.submitted");
    expect(pay).toHaveLength(1);
    expect(JSON.stringify(pay)).not.toContain("4242 4242");
  });

  it("interposes a price-changed page for repriced offers", async () => {
    const lab = newLab();
    const c = new Client(flightsSite(lab));
    const o = offersFor("TLV", "ATH", "2026-12-14").find((x) => repricedPrice(x) !== null)!;
    const trip = (await c.form("/select", { offer: o.id, pax: "1", route: "TLV>ATH" })).headers.get(
      "location",
    )!;
    expect(await (await c.req(trip)).text()).toContain("המחיר השתנה");
    expect((await c.req(`${trip}/seats`)).headers.get("location")).toBe("/");
    await c.form(`${trip}/accept`, {});
    expect((await c.req(`${trip}/seats`)).status).toBe(200);
  });

  it("autocompletes airports", async () => {
    const c = new Client(flightsSite(newLab()));
    const r = (await (await c.req("/api/airports?q=athe")).json()) as { code: string }[];
    expect(r.map((a) => a.code)).toEqual(["ATH"]);
  });
});

describe("inbox and control api", () => {
  it("exposes codes, events, clock and reset", async () => {
    const lab = newLab();
    const inbox = new Client(inboxSite(lab));
    lab.send({
      channel: "sms",
      to: "0555000101",
      site: "pension",
      body: "code 123456",
      code: "123456",
    });
    const r = await (await inbox.req("/api/latest-code?to=0555000101")).json();
    expect(r.code).toBe("123456");
    expect((await inbox.req("/api/latest-code?to=nobody")).status).toBe(404);
    expect((await (await inbox.req("/api/events?site=inbox")).json()).events).toHaveLength(1);
    await inbox.json("/api/clock/advance", { ms: 1000 });
    await inbox.req("/api/reset", { method: "POST" });
    expect(lab.messages).toHaveLength(0);
    expect(await (await inbox.req("/")).text()).toContain("Lab inbox");
  });

  it("hides everything from callers without the token and logs the probe", async () => {
    const lab = newLab({ token: "s3" });
    const inbox = new Client(inboxSite(lab));
    lab.send({
      channel: "sms",
      to: "0555000101",
      site: "pension",
      body: "code 123456",
      code: "123456",
    });
    for (const path of [
      "/",
      "/api/health",
      "/api/messages",
      "/api/latest-code?to=0555000101",
      "/api/events",
      "/api/config",
      "/api/fixtures",
    ]) {
      expect((await inbox.req(path)).status, path).toBe(404);
    }
    expect((await inbox.req("/api/reset", { method: "POST" })).status).toBe(404);
    expect((await inbox.req("/api/health", { headers: { "x-lab-token": "wrong" } })).status).toBe(
      404,
    );
    expect(lab.messages).toHaveLength(1);
    const probes = lab.events.filter((e) => e.type === "inbox.probe");
    expect(probes.map((e) => e.data.path)).toContain("/api/latest-code");
    expect(JSON.stringify(probes)).not.toContain("123456");
  });

  it("serves the API with the header and the page with a query token", async () => {
    const lab = newLab({ token: "s3" });
    const inbox = new Client(inboxSite(lab));
    lab.send({
      channel: "sms",
      to: "0555000101",
      site: "pension",
      body: "code 123456",
      code: "123456",
    });
    const h = { headers: { "x-lab-token": "s3" } };
    expect((await (await inbox.req("/api/latest-code?to=0555000101", h)).json()).code).toBe(
      "123456",
    );
    expect((await inbox.req("/api/reset", { method: "POST", ...h })).status).toBe(200);
    const page = await inbox.req("/?token=s3");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('name="token" value="s3"');
  });
});
