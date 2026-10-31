import { describe, expect, it } from "vitest";
import { PENSION_USERS } from "../data.js";
import { isValidIsraeliId } from "../lib/core.js";
import { extractPdfText } from "../lib/pdf.js";
import { Client, latestCode, newLab } from "../test-utils.js";
import { inboxSite } from "./inbox.js";
import { pensionAuthSite, pensionSite } from "./pension.js";

const dana = PENSION_USERS[0]!;

function setup(opts = {}) {
  const lab = newLab(opts);
  return { lab, portal: new Client(pensionSite(lab)), auth: new Client(pensionAuthSite(lab)) };
}

async function sendCode(auth: Client, id = dana.idNumber, phone = dana.phone) {
  return auth.form("/embed/send", { idNumber: id, phone, terms: "1" });
}

async function login(s: ReturnType<typeof setup>) {
  await sendCode(s.auth);
  const html = await (
    await s.auth.form("/embed/verify", {
      idNumber: dana.idNumber,
      phone: dana.phone,
      code: latestCode(s.lab, dana.phone),
    })
  ).text();
  const ticket = /ticket:"([^"]+)"/.exec(html)?.[1];
  expect(ticket).toBeTruthy();
  const r = await s.portal.json("/session", { ticket });
  expect(r.status).toBe(200);
}

describe("fixtures", () => {
  it("use valid Israeli ID numbers", () => {
    for (const u of PENSION_USERS) expect(isValidIsraeliId(u.idNumber)).toBe(true);
  });
});

describe("pension login", () => {
  it("embeds the login form from a different origin", async () => {
    const { portal } = setup();
    const html = await (await portal.req("/login")).text();
    expect(html).toMatch(/<iframe[^>]+src="http:\/\/lab\.test:7011\/embed\/login"/);
  });

  it("rejects an invalid ID checksum and a wrong phone without sending SMS", async () => {
    const s = setup();
    expect(await (await sendCode(s.auth, "123456789")).text()).toContain("אינו תקין");
    expect(await (await sendCode(s.auth, dana.idNumber, "0555000199")).text()).toContain(
      "לא נמצאה התאמה",
    );
    expect(s.lab.messages).toHaveLength(0);
  });

  it("requires the terms checkbox", async () => {
    const s = setup();
    const html = await (
      await s.auth.form("/embed/send", { idNumber: dana.idNumber, phone: dana.phone })
    ).text();
    expect(html).toContain("תנאי השימוש");
    expect(s.lab.messages).toHaveLength(0);
  });

  it("logs in with the SMS code, then reads the dashboard", async () => {
    const s = setup();
    await login(s);
    const html = await (await s.portal.req("/dashboard")).text();
    expect(html).toContain("דנה אלון");
    expect(html).not.toContain("13.21"); // yearly returns are only in the PDFs
    expect(s.lab.events.some((e) => e.type === "otp.verify" && e.data.ok === true)).toBe(true);
  });

  it("enforces the resend cooldown", async () => {
    const s = setup();
    await sendCode(s.auth);
    const again = await (await sendCode(s.auth)).text();
    expect(again).toContain("ניתן לבקש קוד חדש");
    expect(s.lab.messages).toHaveLength(1);
    s.lab.advanceClock(31_000);
    await sendCode(s.auth);
    expect(s.lab.messages).toHaveLength(2);
  });

  it("expires the code after five minutes", async () => {
    const s = setup();
    await sendCode(s.auth);
    const code = latestCode(s.lab, dana.phone);
    s.lab.advanceClock(5 * 60_000 + 1);
    const html = await (
      await s.auth.form("/embed/verify", { idNumber: dana.idNumber, phone: dana.phone, code })
    ).text();
    expect(html).toContain("תוקף הקוד פג");
    expect(html).not.toContain("login-ok");
  });

  it("locks out after three wrong codes, even with the right one", async () => {
    const s = setup();
    await sendCode(s.auth);
    const code = latestCode(s.lab, dana.phone);
    for (let i = 0; i < 3; i++)
      await s.auth.form("/embed/verify", {
        idNumber: dana.idNumber,
        phone: dana.phone,
        code: "000000",
      });
    const html = await (
      await s.auth.form("/embed/verify", { idNumber: dana.idNumber, phone: dana.phone, code })
    ).text();
    expect(html).toContain("ננעלה");
    expect(html).not.toContain("login-ok");
    s.lab.advanceClock(16 * 60_000);
    await sendCode(s.auth);
    expect(s.lab.messages).toHaveLength(2);
  });

  it("bounces to login after inactivity", async () => {
    const s = setup();
    await login(s);
    s.lab.advanceClock(11 * 60_000);
    const r = await s.portal.req("/dashboard");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/login?expired=1");
  });

  it("does not serve data without a session", async () => {
    const { portal } = setup();
    expect((await portal.req("/reports/2024/dana-pension.pdf")).status).toBe(401);
  });
});

describe("annual report PDFs", () => {
  it("lists 2023-2025 and the PDFs contain the yearly returns", async () => {
    const s = setup();
    await login(s);
    const list = await (await s.portal.req("/reports")).text();
    for (const y of [2023, 2024, 2025]) expect(list).toContain(`/reports/${y}/dana-pension.pdf`);
    for (const f of dana.funds) {
      for (const rep of f.reports) {
        const res = await s.portal.req(`/reports/${rep.year}/${f.id}.pdf`);
        expect(res.headers.get("content-type")).toBe("application/pdf");
        const text = await extractPdfText(Buffer.from(await res.arrayBuffer()));
        expect(text).toContain(`${rep.returnPct.toFixed(2)}%`);
        expect(text).toContain(
          rep.closingBalance.toLocaleString("en-US", { minimumFractionDigits: 2 }),
        );
        expect(text).toContain(`Annual report ${rep.year}`);
      }
    }
  });

  it("does not let one member fetch another member's report", async () => {
    const s = setup();
    await login(s);
    expect((await s.portal.req("/reports/2024/yossi-pension.pdf")).status).toBe(404);
  });
});

describe("A/B variants", () => {
  it("inline: the login form is on the top page and starts the session itself", async () => {
    const s = setup();
    s.lab.config.pension.login = "inline";
    const login = await (await s.portal.req("/login")).text();
    expect(login).not.toContain("<iframe");
    expect(login).toContain('action="/embed/send"');
    await s.portal.form("/embed/send", { idNumber: dana.idNumber, phone: dana.phone, terms: "1" });
    const r = await s.portal.form("/embed/verify", {
      idNumber: dana.idNumber,
      phone: dana.phone,
      code: latestCode(s.lab, dana.phone),
    });
    expect(r.headers.get("location")).toBe("/dashboard");
    expect((await s.portal.req("/dashboard")).status).toBe(200);
  });

  it("no-otp: ID and phone are enough and no SMS is sent", async () => {
    const s = setup();
    s.lab.config.pension.otp = false;
    const html = await (await sendCode(s.auth)).text();
    expect(html).toContain("login-ok");
    expect(s.lab.messages).toHaveLength(0);
    expect(s.lab.events.some((e) => e.type === "otp.skipped")).toBe(true);
  });

  it("html: the yearly returns are also on screen", async () => {
    const s = setup();
    await login(s);
    expect(await (await s.portal.req("/reports")).text()).not.toContain("13.21%");
    s.lab.config.pension.html = true;
    const html = await (await s.portal.req("/reports")).text();
    expect(html).toContain('<td data-year="2024">13.21%</td>');
  });

  it("config endpoint switches variants and reset restores the defaults", async () => {
    const lab = newLab();
    const inbox = new Client(inboxSite(lab));
    await inbox.json("/api/config", { pension: { otp: false } });
    expect(lab.config.pension.otp).toBe(false);
    expect((await inbox.json("/api/config", { pension: { login: "nope" } })).status).toBe(400);
    await inbox.req("/api/reset", { method: "POST" });
    expect(lab.config.pension).toEqual({
      login: "iframe",
      otp: true,
      html: false,
      otpWidget: "single",
    });
  });

  it("otp widgets: slots mirrors digits into boxes over one real input; split has six inputs", async () => {
    const s = setup();
    s.lab.config.pension.otpWidget = "slots";
    const slots = await (await sendCode(s.auth)).text();
    expect(slots.match(/<input[^>]*name="code"/g)).toHaveLength(1);
    expect(slots).toContain('autocomplete="one-time-code"');
    expect(slots).toContain("data-otp-slots");
    expect(slots.match(/<div style="width:36px/g)).toHaveLength(6);
    const s2 = setup();
    s2.lab.config.pension.otpWidget = "split";
    const split = await (await sendCode(s2.auth)).text();
    expect(split.match(/maxlength="1"/g)).toHaveLength(6);
    expect(split).toContain('name="code" id="code"');
    // Whatever the widget, the server still takes one `code` field.
    const code = latestCode(s2.lab, dana.phone);
    const ok = await (
      await s2.auth.form("/embed/verify", { idNumber: dana.idNumber, phone: dana.phone, code })
    ).text();
    expect(ok).toContain("login-ok");
  });

  it("config accepts otpWidget and rejects unknown values", async () => {
    const lab = newLab();
    const inbox = new Client(inboxSite(lab));
    expect((await inbox.json("/api/config", { pension: { otpWidget: "slots" } })).status).toBe(200);
    expect(lab.config.pension.otpWidget).toBe("slots");
    expect((await inbox.json("/api/config", { pension: { otpWidget: "carousel" } })).status).toBe(
      400,
    );
  });
});
