import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { KIND_LABEL, PENSION_USERS, type PensionUser } from "../data.js";
import {
  esc,
  hostOf,
  isValidIsraeliId,
  type Lab,
  normalizePhone,
  requestLogger,
} from "../lib/core.js";
import { failureText, Otp } from "../lib/otp.js";
import { pensionReportPdf } from "../lib/pdf.js";
import { cookieBanner, page, shekel } from "../lib/ui.js";

const CSS = `:root{--brand:#0f6b5c}header.top nav{margin-inline-start:auto;display:flex;gap:16px}
iframe.login{width:100%;max-width:480px;height:540px;border:1px solid #cfd8dc;border-radius:8px;background:#fff}
.fund{display:flex;justify-content:space-between;align-items:center}.big{font-size:26px;font-weight:700}
details summary{cursor:pointer;font-weight:700;padding:8px 0}`;

const SESSION = "kp_sess";
const COOKIES = "אנו משתמשים בעוגיות כדי לשפר את החוויה.";

/** The "html" variant: the same yearly returns that the PDFs hold, also on screen. */
function returnsTable(user: PensionUser): string {
  const rows = user.funds
    .map(
      (f) =>
        `<tr data-fund="${f.id}"><td>${esc(f.nameHe)}</td>${[2023, 2024, 2025]
          .map(
            (y) =>
              `<td data-year="${y}">${f.reports.find((r) => r.year === y)!.returnPct.toFixed(2)}%</td>`,
          )
          .join("")}</tr>`,
    )
    .join("");
  return `<h2>תשואות שנתיות</h2><table data-testid="returns"><thead><tr><th>מוצר</th><th>2023</th><th>2024</th><th>2025</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function userByIdNumber(id: string): PensionUser | undefined {
  return PENSION_USERS.find((u) => u.idNumber === id.padStart(9, "0"));
}

const ticketsOf = (lab: Lab) => lab.state("pension:tickets", () => new Map<string, string>());

/** The member-facing portal. Login happens in an iframe served from a different origin (port). */
export function pensionSite(lab: Lab): Hono {
  const app = new Hono();
  app.use("*", requestLogger(lab, "pension"));

  const head = (
    user: PensionUser,
    active: string,
  ) => `<header class="top"><strong>קדם פנסיה · Kedem</strong>
<nav><a href="/dashboard">${active === "d" ? "<u>סקירה</u>" : "סקירה"}</a>
<a href="/reports">${active === "r" ? "<u>דוחות שנתיים</u>" : "דוחות שנתיים"}</a>
<span>${esc(user.nameHe)}</span><a href="/logout">יציאה</a></nav></header>`;

  function auth(c: Context): { user: PensionUser } | { redirect: Response } {
    const s = lab.touch(getCookie(c, SESSION));
    if (s === "expired") {
      lab.log("pension", "session.expired", {});
      return { redirect: c.redirect("/login?expired=1") };
    }
    if (!s) return { redirect: c.redirect("/login") };
    return { user: PENSION_USERS.find((u) => u.id === s.userId)! };
  }

  app.get("/", (c) =>
    c.html(
      page(
        { title: "קדם פנסיה", css: CSS },
        `<header class="top"><strong>קדם פנסיה · Kedem</strong></header><main><div class="card">
<h1>החיסכון שלך, במקום אחד</h1><p>צפייה בקרנות הפנסיה, ההשתלמות וקופות הגמל.</p>
<a class="btn" href="/login">כניסה לאזור האישי</a></div></main>${cookieBanner(COOKIES, "אישור")}`,
      ),
    ),
  );

  app.route("/", authRoutes(lab));

  app.get("/login", (c) => {
    if (lab.config.pension.login === "inline") {
      return c.html(
        page(
          { title: "כניסה לאזור האישי - קדם פנסיה", css: CSS },
          `<header class="top"><strong>קדם פנסיה · Kedem</strong></header><main>
${c.req.query("expired") ? '<div class="card err" role="alert">החיבור פג עקב חוסר פעילות. יש להיכנס מחדש.</div>' : ""}
<div class="card"><h1>כניסה לאזור האישי</h1>${loginForm(lab)}</div></main>${cookieBanner(COOKIES, "אישור")}`,
        ),
      );
    }
    const authOrigin = `${lab.scheme}://${hostOf(c)}:${lab.ports.auth}`;
    return c.html(
      page(
        { title: "כניסה לאזור האישי - קדם פנסיה", css: CSS },
        `<header class="top"><strong>קדם פנסיה · Kedem</strong></header><main>
${c.req.query("expired") ? '<div class="card err" role="alert">החיבור פג עקב חוסר פעילות. יש להיכנס מחדש.</div>' : ""}
<div class="card"><h1>כניסה לאזור האישי</h1>
<iframe class="login" title="כניסה מאובטחת" src="${authOrigin}/embed/login"></iframe></div></main>
${cookieBanner(COOKIES, "אישור")}
<script>addEventListener('message',function(e){if(e.origin!==${JSON.stringify(authOrigin)})return;var d=e.data||{};
if(d.type==='login-ok'){fetch('/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ticket:d.ticket})})
.then(function(r){if(r.ok)location.href='/dashboard'})}});</script>`,
      ),
    );
  });

  app.post("/session", async (c) => {
    const { ticket } = (await c.req.json().catch(() => ({}))) as { ticket?: string };
    const userId = ticket ? ticketsOf(lab).get(ticket) : undefined;
    if (!ticket || !userId) return c.json({ error: "bad ticket" }, 403);
    ticketsOf(lab).delete(ticket);
    setCookie(c, SESSION, lab.startSession(userId), { path: "/", httpOnly: true, sameSite: "Lax" });
    lab.log("pension", "login.success", { userId });
    return c.json({ ok: true });
  });

  app.get("/logout", (c) => {
    deleteCookie(c, SESSION, { path: "/" });
    return c.redirect("/login");
  });

  app.get("/dashboard", (c) => {
    const a = auth(c);
    if ("redirect" in a) return a.redirect;
    const total = a.user.funds.reduce((s, f) => s + f.balance, 0);
    const cards = a.user.funds
      .map(
        (
          f,
        ) => `<div class="card fund" data-testid="fund" data-fund="${f.id}"><div><div class="muted">${KIND_LABEL[f.kind].he}</div>
<strong>${esc(f.nameHe)}</strong><div class="muted">תשואה מתחילת השנה: ${f.ytdReturnPct.toFixed(2)}%</div></div>
<div class="big">${shekel(f.balance)}</div></div>`,
      )
      .join("");
    return c.html(
      page(
        { title: "סקירה - קדם פנסיה", css: CSS },
        `${head(a.user, "d")}<main><h1>שלום ${esc(a.user.nameHe)}</h1>
<div class="card"><span class="muted">סך החסכונות</span><div class="big" data-testid="total">${shekel(total)}</div></div>${cards}
<p class="muted">תשואות שנתיות ופירוט דמי ניהול מופיעים בדוחות השנתיים.</p></main>
<div class="modal-bg" id="promo" style="display:none"><div class="modal" role="dialog" aria-label="מבצע"><h2>הצטרפו לקדם פלוס</h2>
<p>הטבות בלעדיות ללקוחות קדם.</p><button id="promo-yes">לפרטים</button> <button class="secondary" id="promo-no">לא תודה</button></div></div>
<script>(function(){if(document.cookie.indexOf('promo=1')>=0)return;var m=document.getElementById('promo');m.style.display='flex';
function close(){document.cookie='promo=1;path=/';m.remove()}document.getElementById('promo-no').onclick=close;
document.getElementById('promo-yes').onclick=close})();</script>`,
      ),
    );
  });

  app.get("/reports", (c) => {
    const a = auth(c);
    if ("redirect" in a) return a.redirect;
    const sections = [2025, 2024, 2023]
      .map((y) => {
        const rows = a.user.funds
          .map(
            (f) => `<tr><td>${esc(f.nameHe)}</td><td>${KIND_LABEL[f.kind].he}</td>
<td><a href="/reports/${y}/${f.id}.pdf" target="_blank" download>הורדת דוח שנתי ${y} (PDF)</a></td></tr>`,
          )
          .join("");
        return `<details ${y === 2025 ? "open" : ""}><summary>דוחות שנתיים ${y}</summary>
<table><thead><tr><th>מוצר</th><th>סוג</th><th>מסמך</th></tr></thead><tbody>${rows}</tbody></table></details>`;
      })
      .join("");
    return c.html(
      page(
        { title: "דוחות שנתיים - קדם פנסיה", css: CSS },
        `${head(a.user, "r")}<main><h1>דוחות שנתיים</h1>${sections}${lab.config.pension.html ? returnsTable(a.user) : ""}</main>`,
      ),
    );
  });

  app.get("/reports/:year/:file", async (c) => {
    const a = auth(c);
    if ("redirect" in a) return c.text("unauthorized", 401);
    const year = Number(c.req.param("year"));
    const fundId = c.req.param("file").replace(/\.pdf$/, "");
    const fund = a.user.funds.find((f) => f.id === fundId);
    const rep = fund?.reports.find((r) => r.year === year);
    if (!fund || !rep) return c.text("not found", 404);
    lab.log("pension", "report.download", { userId: a.user.id, fundId, year });
    const pdf = await pensionReportPdf(a.user, fund, rep);
    return new Response(new Uint8Array(pdf), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="annual-report-${year}-${fund.kind}.pdf"`,
      },
    });
  });

  return app;
}

/** The one-time-code box in the three shapes real sites use. All of them submit one `code` field. */
function codeInput(widget: "single" | "slots" | "split"): string {
  if (widget === "slots") {
    return `<label for="code">קוד אימות</label>
<div style="position:relative;display:inline-block;direction:ltr;height:48px">
<input id="code" name="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code"
 style="position:absolute;inset:0;width:100%;max-width:none;height:100%;padding:0;border:0;background:transparent;color:transparent;caret-color:transparent;letter-spacing:44px;font-size:1px;z-index:1">
<div aria-hidden="true" data-otp-slots style="display:flex;gap:8px;pointer-events:none">${Array.from({ length: 6 }, () => '<div style="width:36px;height:48px;border:1px solid #9aa7b3;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:20px"></div>').join("")}</div></div>
<script>(function(){var i=document.getElementById('code'),s=document.querySelectorAll('[data-otp-slots] div');
function d(){var v=i.value.replace(/\\D/g,'').slice(0,6);if(v!==i.value)i.value=v;s.forEach(function(e,k){e.textContent=v[k]||''})}
i.addEventListener('input',d);d()})();</script>`;
  }
  if (widget === "split") {
    return `<label for="code0">קוד אימות</label><input type="hidden" name="code" id="code">
<div style="display:flex;gap:8px;direction:ltr" data-otp-split>${Array.from({ length: 6 }, (_, k) => `<input id="code${k}" inputmode="numeric" maxlength="1" ${k === 0 ? 'autocomplete="one-time-code"' : ""} style="width:36px;text-align:center" aria-label="ספרה ${k + 1}">`).join("")}</div>
<script>(function(){var b=[].slice.call(document.querySelectorAll('[data-otp-split] input')),h=document.getElementById('code');
function j(){h.value=b.map(function(e){return e.value}).join('')}
b.forEach(function(e,k){e.addEventListener('input',function(){e.value=e.value.replace(/\\D/g,'').slice(-1);j();if(e.value&&b[k+1])b[k+1].focus()});
e.addEventListener('keydown',function(ev){if(ev.key==='Backspace'&&!e.value&&b[k-1])b[k-1].focus()});
e.addEventListener('paste',function(ev){var t=(ev.clipboardData.getData('text')||'').replace(/\\D/g,'').slice(0,6);if(!t)return;ev.preventDefault();b.forEach(function(x,n){x.value=t[n]||''});j()})})})();</script>`;
  }
  return '<label for="code">קוד אימות</label><input id="code" name="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code">';
}

function loginForm(lab: Lab, err = "", id = "", phone = ""): string {
  return `<div class="f"><h2>כניסה מאובטחת</h2>
${err ? `<div class="err" role="alert">${esc(err)}</div>` : ""}
<form method="post" action="/embed/send">
<label for="id">מספר תעודת זהות</label><input id="id" name="idNumber" inputmode="numeric" autocomplete="off" value="${esc(id)}">
<label for="phone">טלפון נייד</label><input id="phone" name="phone" inputmode="tel" value="${esc(phone)}">
<label style="font-weight:400"><input type="checkbox" name="terms" value="1"> קראתי ואני מסכים/ה לתנאי השימוש</label>
<p><button type="submit">${lab.config.pension.otp ? "שליחת קוד ב-SMS" : "כניסה"}</button></p></form></div>`;
}

const SESSION_COOKIE = SESSION;

/**
 * The login routes. By default they are served from their own origin (port 7011) and embedded as an
 * iframe, handing the portal a one-time ticket; in the "inline" variant the portal mounts the same
 * routes on its own origin and the final step starts the session directly.
 */
function authRoutes(lab: Lab): Hono {
  const app = new Hono();
  const otp = new Otp(lab, "pension");
  const inline = () => lab.config.pension.login === "inline";

  const form = (err = "", id = "", phone = "") => loginForm(lab, err, id, phone);

  const codeForm = (
    idNumber: string,
    phone: string,
    err = "",
    wait = 30,
  ) => `<div class="f"><h2>הזנת קוד</h2>
<p class="muted">שלחנו קוד בן 6 ספרות ל-${esc(phone.slice(0, 3))}-XXXX${esc(phone.slice(-3))}</p>
${err ? `<div class="err" role="alert">${esc(err)}</div>` : ""}
<form method="post" action="/embed/verify"><input type="hidden" name="idNumber" value="${esc(idNumber)}">
<input type="hidden" name="phone" value="${esc(phone)}">
${codeInput(lab.config.pension.otpWidget)}
<p><button type="submit">אישור</button></p></form>
<form method="post" action="/embed/send"><input type="hidden" name="idNumber" value="${esc(idNumber)}">
<input type="hidden" name="phone" value="${esc(phone)}"><input type="hidden" name="terms" value="1">
<button class="secondary" id="resend" type="submit" disabled>שליחה מחדש (<span id="left">${wait}</span>)</button></form></div>
<script>(function(){var n=${wait},b=document.getElementById('resend'),s=document.getElementById('left');
function on(){b.disabled=false;b.textContent='שליחה מחדש'}if(n<=0)return on();
var t=setInterval(function(){n--;if(n<=0){clearInterval(t);on()}else s.textContent=n},1000)})();</script>`;

  const wrap = (body: string) =>
    page(
      { title: "כניסה מאובטחת", css: `${CSS}body{background:#fff}.f{padding:16px}` },
      inline()
        ? `<header class="top"><strong>קדם פנסיה · Kedem</strong></header><main><div class="card">${body}</div></main>`
        : body,
    );

  /** Login succeeded: hand a ticket to the portal (iframe) or start the session here (inline). */
  const complete = (c: Context, user: PensionUser) => {
    if (inline()) {
      setCookie(c, SESSION_COOKIE, lab.startSession(user.id), {
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      });
      lab.log("pension", "login.success", { userId: user.id });
      return c.redirect("/dashboard");
    }
    const ticket = lab.token("tkt");
    ticketsOf(lab).set(ticket, user.id);
    return c.html(
      wrap(`<div class="f"><p class="ok">הזיהוי הצליח, מעבירים אותך...</p></div>
<script>parent.postMessage({type:'login-ok',ticket:${JSON.stringify(ticket)}},'*')</script>`),
    );
  };

  app.get("/embed/login", (c) => c.html(wrap(form())));

  app.post("/embed/send", async (c) => {
    const f = await c.req.parseBody();
    const idNumber = String(f.idNumber ?? "").trim();
    const phone = normalizePhone(String(f.phone ?? ""));
    lab.log("auth", "login.attempt", { idNumber, phone });
    if (!f.terms) return c.html(wrap(form("יש לאשר את תנאי השימוש.", idNumber, phone)));
    if (!isValidIsraeliId(idNumber))
      return c.html(wrap(form("מספר תעודת הזהות אינו תקין.", idNumber, phone)));
    const user = userByIdNumber(idNumber);
    if (!user || normalizePhone(user.phone) !== phone) {
      return c.html(
        wrap(form("לא נמצאה התאמה בין הפרטים שהוזנו. בדקו ונסו שוב.", idNumber, phone)),
      );
    }
    if (!lab.config.pension.otp) {
      lab.log("pension", "otp.skipped", { key: user.id });
      return complete(c, user);
    }
    const r = otp.send(user.id, "sms", user.phone);
    if (!r.ok) {
      const wait = r.reason === "cooldown" ? Math.ceil(r.retryAfterMs / 1000) : 0;
      return c.html(wrap(codeForm(idNumber, phone, failureText(r), wait)));
    }
    return c.html(wrap(codeForm(idNumber, phone, "", Math.ceil(r.cooldownMs / 1000))));
  });

  app.post("/embed/verify", async (c) => {
    const f = await c.req.parseBody();
    const idNumber = String(f.idNumber ?? "");
    const phone = String(f.phone ?? "");
    const user = userByIdNumber(idNumber);
    if (!user) return c.html(wrap(form("יש להתחיל מחדש.")));
    const r = otp.verify(user.id, String(f.code ?? ""));
    if (!r.ok) return c.html(wrap(codeForm(idNumber, phone, failureText(r), 0)));
    return complete(c, user);
  });

  return app;
}

/** The cross-origin login frame (port 7011). */
export function pensionAuthSite(lab: Lab): Hono {
  const app = new Hono();
  app.use("*", requestLogger(lab, "auth"));
  app.route("/", authRoutes(lab));
  return app;
}
