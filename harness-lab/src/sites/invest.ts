import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { INVEST_USERS, type InvestUser, STATEMENT_MONTHS, statementRows } from "../data.js";
import { hash, type Lab, requestLogger, sleep } from "../lib/core.js";
import { failureText, Otp } from "../lib/otp.js";
import { quarterlyPdf, statementPdf } from "../lib/pdf.js";
import { cookieBanner, page } from "../lib/ui.js";

const SESS = "tv_sess";
const PRE = "tv_pre";

const CSS = `:root{--brand:#7a3b8f}.hide{display:none!important}nav.menu{display:flex;gap:4px;margin-inline-start:24px;position:relative}
nav.menu .item{position:relative}nav.menu button{background:transparent}.dd{position:absolute;top:100%;inset-inline-start:0;background:#fff;color:#1c2733;
border:1px solid #cfd8dc;border-radius:6px;min-width:180px;z-index:20}.dd a,.dd button{display:block;color:#1c2733;padding:8px 12px;background:transparent;text-align:start;width:100%;text-decoration:none;border-radius:0}
.dd2{position:absolute;top:0;inset-inline-start:100%;background:#fff;border:1px solid #cfd8dc;min-width:160px;border-radius:6px}
.spin{width:36px;height:36px;border:4px solid #ddd;border-top-color:#7a3b8f;border-radius:50%;animation:s 1s linear infinite;margin:24px auto}
@keyframes s{to{transform:rotate(360deg)}}td.num,th.num{text-align:end}.neg{color:#b00020}.pos{color:#0a7a3d}`;

const CLIENT = `
(function(){
var root=document.getElementById('root'),state={user:null};
function h(s){var d=document.createElement('div');d.innerHTML=s;return d.firstElementChild}
function api(path,opt){opt=opt||{};if(opt.body&&typeof opt.body!=='string'){opt.body=JSON.stringify(opt.body);opt.headers={'content-type':'application/json'}}
return fetch(path,opt).then(function(r){if(r.status===401&&path!=='/api/login'&&path.indexOf('/api/2fa')<0){state.user=null;go('/?expired=1');throw new Error('401')}return r})}
function go(p){history.pushState({},'',p);route()}
function money(n){return n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}
function spinner(){return '<div class="spin" role="progressbar" aria-label="טוען"></div>'}
function shell(inner){
 root.innerHTML='<header class="top"><strong>תבור בית השקעות · Tavor</strong><nav class="menu" id="menu">'+
 '<div class="item"><button data-r="/app/portfolio">תיק השקעות</button></div>'+
 '<div class="item"><button data-r="/app/statements">דפי חשבון</button></div>'+
 '<div class="item"><button id="m-rep" aria-haspopup="true">דוחות ▾</button><div class="dd hide" id="dd1">'+
 '<button id="m-per" aria-haspopup="true">דוחות תקופתיים ◂</button><div class="dd2 hide" id="dd2"><button data-r="/app/reports/quarterly">רבעוני</button><button data-r="/app/reports/tax">שנתי למס (בקרוב)</button></div></div></div>'+
 '</nav><span style="margin-inline-start:auto">'+state.user.nameHe+'</span><button class="secondary" id="logout">יציאה</button></header>'+
 '<main><tv-account-summary></tv-account-summary><div id="view">'+inner+'</div></main>';
 root.querySelectorAll('[data-r]').forEach(function(b){b.onclick=function(){go(b.getAttribute('data-r'))}});
 document.getElementById('m-rep').onclick=function(){document.getElementById('dd1').classList.toggle('hide')};
 document.getElementById('m-per').onclick=function(){document.getElementById('dd2').classList.toggle('hide')};
 document.getElementById('logout').onclick=function(){api('/api/logout',{method:'POST'}).then(function(){state.user=null;go('/')})};
}
class Summary extends HTMLElement{connectedCallback(){var s=this.attachShadow({mode:'open'});
 s.innerHTML='<style>.w{background:#fff;border:1px solid #d9e0e6;border-radius:8px;padding:12px 16px;margin-bottom:16px;display:flex;gap:32px;font-family:system-ui}.l{color:#66737f;font-size:13px}.v{font-size:22px;font-weight:700}</style><div class="w" part="widget">טוען סיכום...</div>';
 api('/api/summary').then(function(r){return r.json()}).then(function(d){
  s.querySelector('.w').innerHTML='<div><div class="l">שווי תיק</div><div class="v" id="total">'+money(d.total)+' ₪</div></div><div><div class="l">יתרת מזומן</div><div class="v" id="cash">'+money(d.cash)+' ₪</div></div><div><div class="l">רווח/הפסד יומי</div><div class="v" id="day">'+money(d.day)+' ₪</div></div>'}).catch(function(){})}}
customElements.define('tv-account-summary',Summary);
function loadTable(url,render){var v=document.getElementById('view');v.innerHTML=spinner();
 api(url).then(function(r){return r.json()}).then(function(d){v.innerHTML=render(d)}).catch(function(){})}
var views={
 '/app/portfolio':function(){loadTable('/api/holdings',function(d){return '<h1>תיק ההשקעות</h1><table data-testid="holdings"><thead><tr><th>סימול</th><th>נייר</th><th class="num">כמות</th><th class="num">מחיר</th><th class="num">שווי</th><th class="num">רווח/הפסד</th></tr></thead><tbody>'+
  d.rows.map(function(r){var pl=r.value-r.cost;return '<tr><td>'+r.symbol+'</td><td>'+r.name+'</td><td class="num">'+r.qty+'</td><td class="num">'+money(r.price)+'</td><td class="num">'+money(r.value)+'</td><td class="num '+(pl<0?'neg':'pos')+'">'+money(pl)+'</td></tr>'}).join('')+'</tbody></table>'})},
 '/app/statements':function(){loadTable('/api/statements',function(d){return '<h1>דפי חשבון</h1><table data-testid="statements"><thead><tr><th>חודש</th><th>מסמכים</th></tr></thead><tbody>'+
  d.months.map(function(m){return '<tr><td>'+m+'</td><td><a href="/api/statements/'+m+'.pdf" download>PDF</a> · <a href="/api/statements/'+m+'.csv" download>CSV</a></td></tr>'}).join('')+'</tbody></table>'})},
 '/app/reports/quarterly':function(){loadTable('/api/reports/quarterly',function(d){return '<h1>דוח רבעוני</h1><table data-testid="quarterly"><thead><tr><th>רבעון</th><th>מסמך</th></tr></thead><tbody>'+
  d.quarters.map(function(q){return '<tr><td>'+q+'</td><td><a href="/api/reports/quarterly/'+q+'.pdf" download>הורדת דוח (PDF)</a></td></tr>'}).join('')+'</tbody></table>'})},
 '/app/reports/tax':function(){document.getElementById('view').innerHTML='<h1>בקרוב</h1>'}
};
function loginView(){
 var exp=location.search.indexOf('expired')>=0;
 root.innerHTML='<header class="top"><strong>תבור בית השקעות · Tavor</strong></header><main><div class="card" style="max-width:420px"><h1>כניסה לחשבון</h1>'+(exp?'<div class="err" role="alert">ההתחברות פגה. יש להתחבר מחדש.</div>':'')+
 '<div id="step"></div></div></main>';
 var step=document.getElementById('step');
 function creds(err){step.innerHTML=(err?'<div class="err" role="alert">'+err+'</div>':'')+'<label for="u">שם משתמש או ת.ז.</label><input id="u" autocomplete="username"><label for="p">סיסמה</label><input id="p" type="password" autocomplete="current-password"><p><button id="go">המשך</button></p>';
  document.getElementById('go').onclick=function(){api('/api/login',{method:'POST',body:{username:document.getElementById('u').value,password:document.getElementById('p').value}}).then(function(r){return r.json().then(function(d){return[r.status,d]})}).then(function(x){if(x[0]!==200)return creds(x[1].error);choose(x[1].methods)})}}
 function choose(methods){step.innerHTML='<h2>אימות דו-שלבי</h2><p>לאן לשלוח את קוד האימות?</p>'+methods.map(function(m){return '<label style="font-weight:400"><input type="radio" name="m" value="'+m.id+'"> '+(m.id==='sms'?'הודעת SMS':'דואר אלקטרוני')+' ('+m.masked+')</label>'}).join('')+'<p><button id="send">שליחת קוד</button></p><div id="e" class="err"></div>';
  document.getElementById('send').onclick=function(){var sel=step.querySelector('input[name=m]:checked');if(!sel){document.getElementById('e').textContent='יש לבחור אמצעי שליחה';return}send(sel.value)}}
 function send(method,err){api('/api/2fa/send',{method:'POST',body:{method:method}}).then(function(r){return r.json().then(function(d){return[r.status,d]})}).then(function(x){
  if(x[0]!==200&&x[0]!==429){return step.innerHTML='<div class="err">'+x[1].error+'</div>'}
  step.innerHTML=(x[0]===429?'<div class="err" role="alert">'+x[1].error+'</div>':'')+'<h2>הזנת קוד</h2><label for="c">קוד אימות</label><input id="c" inputmode="numeric" maxlength="6" autocomplete="one-time-code"><div id="e" class="err">'+(err||'')+'</div><p><button id="ok">אישור</button> <button class="secondary" id="again">שליחה מחדש</button></p>';
  document.getElementById('again').onclick=function(){send(method)};
  document.getElementById('ok').onclick=function(){api('/api/2fa/verify',{method:'POST',body:{code:document.getElementById('c').value}}).then(function(r){return r.json().then(function(d){return[r.status,d]})}).then(function(y){if(y[0]===200){state.user=y[1].user;go('/app/portfolio')}else document.getElementById('e').textContent=y[1].error})}})}
 creds('')}
function route(){var p=location.pathname;
 if(p==='/'||p===''){return loginView()}
 var render=function(){shell('');(views[p]||views['/app/portfolio'])()};
 if(state.user)return render();
 api('/api/me').then(function(r){return r.json()}).then(function(d){state.user=d.user;render()}).catch(function(){})}
addEventListener('popstate',route);route();
})();`;

export function investSite(lab: Lab): Hono {
  const app = new Hono();
  app.use("*", requestLogger(lab, "invest"));
  const otp = new Otp(lab, "invest");
  const prelogin = () => lab.state("invest:pre", () => new Map<string, string>());
  const badPw = () => lab.state("invest:badpw", () => new Map<string, number>());

  const delay = async (path: string) => {
    const ms = (2000 + (hash(path) % 2000)) * lab.delayScale;
    if (ms > 0) await sleep(ms);
  };

  function authed(c: Context): InvestUser | undefined {
    const s = lab.touch(getCookie(c, SESS));
    if (!s || s === "expired") {
      if (s === "expired") lab.log("invest", "session.expired", {});
      return undefined;
    }
    return INVEST_USERS.find((u) => u.id === s.userId);
  }
  const deny = (c: Context) => c.json({ error: "session expired" }, 401);
  const mask = (s: string, kind: "phone" | "email") =>
    kind === "phone"
      ? `${s.slice(0, 3)}-XXXX${s.slice(-3)}`
      : `${s.slice(0, 2)}***@${s.split("@")[1]}`;

  const shell = (c: Context) =>
    c.html(
      page(
        { title: "תבור בית השקעות", css: CSS },
        `<div id="root"></div>${cookieBanner("האתר משתמש בעוגיות.", "הבנתי")}<script>${CLIENT}</script>`,
      ),
    );
  app.get("/", shell);
  app.get("/app/*", shell);

  app.post("/api/login", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { username?: string; password?: string };
    const name = String(b.username ?? "")
      .trim()
      .toLowerCase();
    lab.log("invest", "login.attempt", { username: name });
    const user = INVEST_USERS.find((u) => u.username === name || u.idNumber === name);
    const fails = badPw().get(name) ?? 0;
    if (fails >= 5) return c.json({ error: "החשבון ננעל זמנית. פנו לשירות הלקוחות." }, 423);
    if (!user || user.password !== b.password) {
      badPw().set(name, fails + 1);
      return c.json({ error: "שם משתמש או סיסמה שגויים." }, 401);
    }
    badPw().delete(name);
    const pre = lab.token("pre");
    prelogin().set(pre, user.id);
    setCookie(c, PRE, pre, { path: "/", httpOnly: true, sameSite: "Lax" });
    return c.json({
      methods: [
        { id: "sms", masked: mask(user.phone, "phone") },
        { id: "email", masked: mask(user.email, "email") },
      ],
    });
  });

  const preUser = (c: Context) => {
    const id = prelogin().get(getCookie(c, PRE) ?? "");
    return INVEST_USERS.find((u) => u.id === id);
  };

  app.post("/api/2fa/send", async (c) => {
    const user = preUser(c);
    if (!user) return c.json({ error: "יש להתחבר מחדש." }, 401);
    const { method } = (await c.req.json().catch(() => ({}))) as { method?: string };
    if (method !== "sms" && method !== "email") return c.json({ error: "אמצעי לא תקין" }, 400);
    const r = otp.send(user.id, method, method === "sms" ? user.phone : user.email);
    if (!r.ok) return c.json({ error: failureText(r) }, r.reason === "locked" ? 423 : 429);
    return c.json({ ok: true, cooldownSeconds: r.cooldownMs / 1000 });
  });

  app.post("/api/2fa/verify", async (c) => {
    const user = preUser(c);
    if (!user) return c.json({ error: "יש להתחבר מחדש." }, 401);
    const { code } = (await c.req.json().catch(() => ({}))) as { code?: string };
    const r = otp.verify(user.id, String(code ?? ""));
    if (!r.ok) return c.json({ error: failureText(r) }, r.reason === "locked" ? 423 : 400);
    prelogin().delete(getCookie(c, PRE) ?? "");
    setCookie(c, SESS, lab.startSession(user.id), { path: "/", httpOnly: true, sameSite: "Lax" });
    lab.log("invest", "login.success", { userId: user.id });
    return c.json({ ok: true, user: { nameHe: user.nameHe } });
  });

  app.post("/api/logout", (c) => {
    deleteCookie(c, SESS, { path: "/" });
    return c.json({ ok: true });
  });

  app.get("/api/me", (c) => {
    const u = authed(c);
    return u ? c.json({ user: { nameHe: u.nameHe } }) : deny(c);
  });

  const total = (u: InvestUser) => u.holdings.reduce((s, h) => s + h.qty * h.price, 0) + u.cash;

  app.get("/api/summary", (c) => {
    const u = authed(c);
    if (!u) return deny(c);
    return c.json({
      total: total(u),
      cash: u.cash,
      day: Math.round(total(u) * 0.0031 * 100) / 100,
    });
  });

  app.get("/api/holdings", async (c) => {
    const u = authed(c);
    if (!u) return deny(c);
    await delay("holdings");
    return c.json({
      rows: u.holdings.map((h) => ({
        symbol: h.symbol,
        name: h.nameHe,
        qty: h.qty,
        price: h.price,
        value: Math.round(h.qty * h.price * 100) / 100,
        cost: Math.round(h.qty * h.costBasis * 100) / 100,
      })),
    });
  });

  app.get("/api/statements", async (c) => {
    const u = authed(c);
    if (!u) return deny(c);
    await delay("statements");
    return c.json({ months: [...STATEMENT_MONTHS].reverse() });
  });

  app.get("/api/statements/:file", async (c) => {
    const u = authed(c);
    if (!u) return deny(c);
    const m = /^(\d{4}-\d{2})\.(pdf|csv)$/.exec(c.req.param("file"));
    if (!m || !(STATEMENT_MONTHS as readonly string[]).includes(m[1]!))
      return c.text("not found", 404);
    lab.log("invest", "statement.download", { userId: u.id, month: m[1], format: m[2] });
    if (m[2] === "csv") {
      const csv = [
        "date,description,amount",
        ...statementRows(u, m[1]!).map(
          (r) => `${r.date},"${r.description}",${r.amount.toFixed(2)}`,
        ),
      ].join("\n");
      return new Response(csv, {
        headers: {
          "content-type": "text/csv",
          "content-disposition": `attachment; filename="statement-${m[1]}.csv"`,
        },
      });
    }
    const pdf = await statementPdf(u, m[1]!);
    return new Response(new Uint8Array(pdf), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="statement-${m[1]}.pdf"`,
      },
    });
  });

  app.get("/api/reports/quarterly", async (c) => {
    const u = authed(c);
    if (!u) return deny(c);
    await delay("quarterly");
    return c.json({ quarters: u.quarters.map((q) => q.quarter).reverse() });
  });

  app.get("/api/reports/quarterly/:file", async (c) => {
    const u = authed(c);
    if (!u) return deny(c);
    const q = c.req.param("file").replace(/\.pdf$/, "");
    if (!u.quarters.some((x) => x.quarter === q)) return c.text("not found", 404);
    lab.log("invest", "report.download", { userId: u.id, quarter: q });
    const pdf = await quarterlyPdf(u, q);
    return new Response(new Uint8Array(pdf), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="quarterly-${q}.pdf"`,
      },
    });
  });

  return app;
}
