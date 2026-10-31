import { describe, expect, it } from "vitest";
import { INVEST_USERS } from "../data.js";
import { extractPdfText } from "../lib/pdf.js";
import { Client, latestCode, newLab } from "../test-utils.js";
import { investSite } from "./invest.js";

const ronen = INVEST_USERS[0]!;

async function login(method: "sms" | "email" = "sms") {
  const lab = newLab();
  const c = new Client(investSite(lab));
  const r = await c.json("/api/login", { username: ronen.username, password: ronen.password });
  expect(r.status).toBe(200);
  expect((await r.json()).methods.map((m: { id: string }) => m.id)).toEqual(["sms", "email"]);
  await c.json("/api/2fa/send", { method });
  const to = method === "sms" ? ronen.phone : ronen.email;
  const v = await c.json("/api/2fa/verify", { code: latestCode(lab, to) });
  expect(v.status).toBe(200);
  return { lab, c };
}

describe("invest login", () => {
  it("rejects a wrong password and locks after five tries", async () => {
    const c = new Client(investSite(newLab()));
    for (let i = 0; i < 5; i++)
      expect((await c.json("/api/login", { username: ronen.username, password: "x" })).status).toBe(
        401,
      );
    expect(
      (await c.json("/api/login", { username: ronen.username, password: ronen.password })).status,
    ).toBe(423);
  });

  it("delivers the second factor by SMS or by email", async () => {
    const sms = await login("sms");
    expect(sms.lab.messages.at(-1)?.channel).toBe("sms");
    const mail = await login("email");
    expect(mail.lab.messages.at(-1)?.channel).toBe("email");
  });

  it("refuses a wrong code and reports attempts left", async () => {
    const lab = newLab();
    const c = new Client(investSite(lab));
    await c.json("/api/login", { username: ronen.username, password: ronen.password });
    await c.json("/api/2fa/send", { method: "sms" });
    const r = await c.json("/api/2fa/verify", { code: "111111" });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain("נותרו 2");
    expect((await c.req("/api/holdings")).status).toBe(401);
  });

  it("expires the session after inactivity", async () => {
    const { lab, c } = await login();
    expect((await c.req("/api/me")).status).toBe(200);
    lab.advanceClock(11 * 60_000);
    expect((await c.req("/api/me")).status).toBe(401);
  });
});

describe("invest data", () => {
  it("serves holdings, statements as PDF and CSV, and the quarterly PDF", async () => {
    const { c } = await login();
    const h = await (await c.req("/api/holdings")).json();
    expect(h.rows).toHaveLength(ronen.holdings.length);
    const csv = await (await c.req("/api/statements/2025-09.csv")).text();
    expect(csv.split("\n")[0]).toBe("date,description,amount");
    expect(csv.split("\n")).toHaveLength(9);
    const st = await c.req("/api/statements/2025-09.pdf");
    expect(await extractPdfText(Buffer.from(await st.arrayBuffer()))).toContain(
      "Account statement 2025-09",
    );
    for (const q of ronen.quarters) {
      const pdf = await c.req(`/api/reports/quarterly/${q.quarter}.pdf`);
      const text = await extractPdfText(Buffer.from(await pdf.arrayBuffer()));
      expect(text).toContain(`${q.returnPct.toFixed(2)}%`);
    }
  });

  it("ships the shell for client-side routes", async () => {
    const c = new Client(investSite(newLab()));
    const html = await (await c.req("/app/reports/quarterly")).text();
    expect(html).toContain("tv-account-summary");
    expect(html).toContain("attachShadow");
  });
});
