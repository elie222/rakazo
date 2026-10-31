import { type Context, Hono } from "hono";
import { setCookie } from "hono/cookie";
import { AIRPORTS } from "../data.js";
import { esc, hash, type Lab, requestLogger } from "../lib/core.js";
import { cookieBanner, page } from "../lib/ui.js";
import { type Offer, offersFor, repricedPrice } from "./flights-data.js";

/** Fixed "today" so date pickers and fares are the same on every run. */
export const TODAY = "2026-11-01";

const CSS = `:root{--brand:#0b6fb8}.row{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end}.field{position:relative}
.sugg{position:absolute;top:100%;inset-inline-start:0;background:#fff;border:1px solid #9aa7b3;width:300px;z-index:30;list-style:none;margin:0;padding:0}
.sugg li{padding:8px 10px;cursor:pointer}.sugg li:hover,.sugg li[aria-selected=true]{background:#e6f1fb}
.cal{position:absolute;top:100%;background:#fff;border:1px solid #9aa7b3;padding:8px;z-index:30;width:280px}.cal .g{display:grid;grid-template-columns:repeat(7,1fr);gap:2px}
.cal button.d{background:#fff;color:#1c2733;padding:6px 0}.cal button.d:disabled{color:#bbb}.cal button.d.sel{background:var(--brand);color:#fff}
.offer{display:grid;grid-template-columns:1.2fr 1fr 1fr auto;gap:12px;align-items:center}.price{font-size:22px;font-weight:700}
.seats{display:grid;grid-template-columns:repeat(3,36px) 24px repeat(3,36px);gap:4px;justify-content:center}
.seat{width:36px;height:34px;padding:0;font-size:12px}.seat.taken{background:#c9d1d8;color:#888}.seat.on{background:#0a7a3d}.seat.legroom{outline:2px solid #e0a100}
.testmode{background:#fff4cf;border:1px solid #e0a100;padding:10px;border-radius:6px;margin-bottom:12px}`;

const head = `<header class="top"><a href="/"><strong>Skybird · סקייברד טיסות</strong></a></header>`;
const fmtDur = (m: number) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;

interface Booking {
  id: string;
  offer: Offer;
  pax: number;
  price: number;
  repriceAccepted: boolean;
  seats: string[];
  passengers: { first: string; last: string; passport: string; dob: string }[];
  contact?: { email: string; phone: string };
  paid?: { last4: string };
  ref?: string;
}

const SEAT_COLS = ["A", "B", "C", "D", "E", "F"];
const takenSeat = (offerId: string, seat: string) => hash(`${offerId}:${seat}`) % 3 === 0;
const seatFee = (row: number) => (row <= 3 ? 25 : 0);

export function flightsSite(lab: Lab): Hono {
  const app = new Hono();
  app.use("*", requestLogger(lab, "flights"));
  const bookings = () => lab.state("flights:bookings", () => new Map<string, Booking>());
  const booking = (c: Context) => bookings().get(c.req.param("bid") ?? "");
  const seatFees = (b: Booking) => b.seats.reduce((s, x) => s + seatFee(Number.parseInt(x, 10)), 0);
  const total = (b: Booking) => b.price * b.pax + seatFees(b);

  app.get("/api/airports", (c) => {
    const q = (c.req.query("q") ?? "").toLowerCase();
    return c.json(
      AIRPORTS.filter(
        (a) => !q || [a.code, a.city, a.cityHe, a.name].some((s) => s.toLowerCase().includes(q)),
      ),
    );
  });

  app.get("/", (c) =>
    c.html(
      page(
        { title: "Skybird - חיפוש טיסות", css: CSS },
        `${head}<main><div class="card"><h1>לאן טסים?</h1>
<form action="/results" method="get" id="search"><div class="row">
<div class="field"><label for="from-t">מוצא</label><input id="from-t" role="combobox" autocomplete="off" placeholder="עיר או שדה תעופה"><input type="hidden" name="from" id="from"><ul class="sugg" hidden></ul></div>
<div class="field"><label for="to-t">יעד</label><input id="to-t" role="combobox" autocomplete="off" placeholder="עיר או שדה תעופה"><input type="hidden" name="to" id="to"><ul class="sugg" hidden></ul></div>
<div class="field"><label for="date-t">תאריך יציאה</label><input id="date-t" readonly placeholder="בחרו תאריך"><input type="hidden" name="date" id="date"><div class="cal" hidden></div></div>
<div><label for="pax">נוסעים</label><select name="pax" id="pax">${[1, 2, 3, 4].map((n) => `<option value="${n}">${n}</option>`).join("")}</select></div>
<div><button type="submit">חיפוש טיסות</button></div></div><div class="err" id="err"></div></form></div></main>${cookieBanner("אנו משתמשים בעוגיות.", "אישור")}
<script>
(function(){
function auto(tid,hid){var inp=document.getElementById(tid),hid=document.getElementById(hid),ul=inp.parentNode.querySelector('.sugg'),t;
 inp.addEventListener('input',function(){hid.value='';clearTimeout(t);t=setTimeout(function(){fetch('/api/airports?q='+encodeURIComponent(inp.value)).then(function(r){return r.json()}).then(function(a){
  ul.innerHTML=a.map(function(x){return '<li role="option" data-code="'+x.code+'">'+x.cityHe+' ('+x.city+') · '+x.code+'</li>'}).join('');ul.hidden=!a.length})},250)});
 ul.addEventListener('click',function(e){var li=e.target.closest('li');if(!li)return;hid.value=li.dataset.code;inp.value=li.textContent;ul.hidden=true})}
auto('from-t','from');auto('to-t','to');
var today=new Date('${TODAY}T00:00:00Z'),view=new Date(Date.UTC(today.getUTCFullYear(),today.getUTCMonth(),1)),inp=document.getElementById('date-t'),hid=document.getElementById('date'),cal=document.querySelector('.cal');
function iso(d){return d.toISOString().slice(0,10)}
function draw(){var y=view.getUTCFullYear(),m=view.getUTCMonth(),first=new Date(Date.UTC(y,m,1)).getUTCDay(),days=new Date(Date.UTC(y,m+1,0)).getUTCDate(),h='<div class="row"><button type="button" class="secondary" id="prev">‹</button><strong>'+(m+1)+'/'+y+'</strong><button type="button" class="secondary" id="next">›</button></div><div class="g">';
 for(var i=0;i<first;i++)h+='<span></span>';
 for(var d=1;d<=days;d++){var dt=new Date(Date.UTC(y,m,d));h+='<button type="button" class="d'+(iso(dt)===hid.value?' sel':'')+'" data-d="'+iso(dt)+'"'+(dt<today?' disabled':'')+'>'+d+'</button>'}
 cal.innerHTML=h+'</div>'}
inp.addEventListener('click',function(){draw();cal.hidden=!cal.hidden});
cal.addEventListener('click',function(e){var b=e.target.closest('button');if(!b)return;if(b.id==='prev'){view.setUTCMonth(view.getUTCMonth()-1);draw()}else if(b.id==='next'){view.setUTCMonth(view.getUTCMonth()+1);draw()}else if(b.dataset.d){hid.value=b.dataset.d;inp.value=b.dataset.d.split('-').reverse().join('/');cal.hidden=true}});
document.getElementById('search').addEventListener('submit',function(e){var f=document.getElementById('from').value,t=document.getElementById('to').value;
 if(!f||!t||!hid.value){e.preventDefault();document.getElementById('err').textContent='יש לבחור מוצא, יעד ותאריך מהרשימה.'}else if(f===t){e.preventDefault();document.getElementById('err').textContent='המוצא והיעד זהים.'}})})();
</script>`,
      ),
    ),
  );

  app.get("/results", (c) => {
    const { from = "", to = "", date = "" } = c.req.query();
    const pax = Math.min(4, Math.max(1, Number(c.req.query("pax") ?? 1)));
    if (
      !AIRPORTS.some((a) => a.code === from) ||
      !AIRPORTS.some((a) => a.code === to) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date)
    ) {
      return c.redirect("/");
    }
    lab.log("flights", "search", { from, to, date, pax });
    const offers = offersFor(from, to, date);
    const airlines = [...new Set(offers.map((o) => o.airline))];
    const cards = offers
      .map(
        (
          o,
          i,
        ) => `<div class="card offer" data-testid="offer" data-price="${o.pricePerPax}" data-dur="${o.durationMin}" data-dep="${o.dep}" data-stops="${o.stops}" data-airline="${esc(o.airline)}" data-i="${i}">
<div><strong>${esc(o.airline)}</strong> ${o.flightNo}<div class="muted">${o.checkedBag ? "כולל מזוודה" : "ללא מזוודה"}</div></div>
<div>${o.dep} → ${o.arr}<div class="muted">${fmtDur(o.durationMin)} · ${o.stops === 0 ? "ישירה" : `${o.stops} עצירות (${o.via})`}</div></div>
<div class="price">$${o.pricePerPax}<div class="muted">לנוסע</div></div>
<form method="post" action="/select"><input type="hidden" name="offer" value="${esc(o.id)}"><input type="hidden" name="pax" value="${pax}"><input type="hidden" name="route" value="${from}>${to}">
<button type="submit">בחירה</button></form></div>`,
      )
      .join("");
    return c.html(
      page(
        { title: `טיסות ${from}-${to}`, css: CSS },
        `${head}<main><h1>${from} → ${to} · ${date} · ${pax} נוסעים</h1><div class="card row">
<div><label for="sort">מיון</label><select id="sort"><option value="rec">מומלץ</option><option value="price">מחיר</option><option value="dur">משך טיסה</option><option value="dep">שעת יציאה</option></select></div>
<div><label for="stops">עצירות</label><select id="stops"><option value="">הכל</option><option value="0">ישירות בלבד</option><option value="1">עד עצירה אחת</option></select></div>
<div><label for="max">מחיר מקסימלי</label><input id="max" type="number" min="0" placeholder="$"></div>
<div><label>חברת תעופה</label>${airlines.map((a) => `<label style="font-weight:400;display:inline-block;margin-inline-end:8px"><input type="checkbox" class="al" value="${esc(a)}" checked> ${esc(a)}</label>`).join("")}</div></div>
<div id="list">${cards}</div><p id="none" class="muted" hidden>לא נמצאו טיסות.</p></main>
<script>(function(){var list=document.getElementById('list'),cards=[].slice.call(list.children);
function apply(){var s=document.getElementById('sort').value,st=document.getElementById('stops').value,mx=Number(document.getElementById('max').value)||1e9,al=[].slice.call(document.querySelectorAll('.al:checked')).map(function(x){return x.value});
 var key={rec:'i',price:'price',dur:'dur',dep:'dep'}[s];
 cards.sort(function(a,b){var x=a.dataset[key],y=b.dataset[key];return key==='dep'?x.localeCompare(y):Number(x)-Number(y)});
 var shown=0;cards.forEach(function(c){var ok=(st===''||Number(c.dataset.stops)<=Number(st))&&Number(c.dataset.price)<=mx&&al.indexOf(c.dataset.airline)>=0;c.hidden=!ok;if(ok)shown++;list.appendChild(c)});
 document.getElementById('none').hidden=shown>0}
document.querySelectorAll('#sort,#stops,#max,.al').forEach(function(e){e.addEventListener('input',apply)})})();</script>`,
      ),
    );
  });

  app.post("/select", async (c) => {
    const f = await c.req.parseBody();
    const offerId = String(f.offer ?? "");
    const [from, to] = String(f.route ?? "").split(">");
    const found = findOffer(offerId, from, to);
    if (!found) return c.redirect("/");
    const pax = Math.min(4, Math.max(1, Number(f.pax ?? 1)));
    const id = lab.token("bk");
    const rp = repricedPrice(found);
    bookings().set(id, {
      id,
      offer: found,
      pax,
      price: found.pricePerPax,
      repriceAccepted: rp === null,
      seats: [],
      passengers: [],
    });
    lab.log("flights", "offer.selected", { offerId, pax, price: found.pricePerPax });
    setCookie(c, "fl_b", id, { path: "/" });
    return c.redirect(`/trip/${id}`);
  });

  const stepNav = (n: number) =>
    `<p class="muted">שלב ${n} מתוך 4 · ${["מחיר", "מושבים", "נוסעים", "תשלום"].map((s, i) => (i + 1 === n ? `<strong>${s}</strong>` : s)).join(" › ")}</p>`;

  app.get("/trip/:bid", (c) => {
    const b = booking(c);
    if (!b) return c.redirect("/");
    const rp = repricedPrice(b.offer);
    if (rp !== null && !b.repriceAccepted) {
      return c.html(
        page(
          { title: "המחיר השתנה", css: CSS },
          `${head}<main><div class="card" role="alertdialog"><h1>המחיר השתנה</h1>
<p>מחיר הכרטיס עודכן מ-$${b.offer.pricePerPax} ל-<strong data-testid="new-price">$${rp}</strong> לנוסע, בהתאם לזמינות.</p>
<form method="post" action="/trip/${b.id}/accept"><button>המשך במחיר החדש</button> <a class="btn secondary" href="/">חזרה לחיפוש</a></form></div></main>`,
        ),
      );
    }
    return c.redirect(`/trip/${b.id}/seats`);
  });

  app.post("/trip/:bid/accept", (c) => {
    const b = booking(c);
    if (!b) return c.redirect("/");
    b.price = repricedPrice(b.offer) ?? b.price;
    b.repriceAccepted = true;
    lab.log("flights", "price.accepted", { price: b.price });
    return c.redirect(`/trip/${b.id}/seats`);
  });

  app.get("/trip/:bid/seats", (c) => {
    const b = booking(c);
    if (!b?.repriceAccepted) return c.redirect("/");
    const rows = Array.from({ length: 12 }, (_, i) => i + 1)
      .map((r) => {
        const cells = SEAT_COLS.map((col) => {
          const s = `${r}${col}`;
          const taken = takenSeat(b.offer.id, s);
          const btn = `<button type="button" class="seat${taken ? " taken" : ""}${seatFee(r) ? " legroom" : ""}${b.seats.includes(s) ? " on" : ""}" data-seat="${s}" ${taken ? "disabled" : ""} aria-label="מושב ${s}${seatFee(r) ? " (+$25)" : ""}">${s}</button>`;
          return col === "C" ? `${btn}<span></span>` : btn;
        }).join("");
        return cells;
      })
      .join("");
    return c.html(
      page(
        { title: "בחירת מושבים", css: CSS },
        `${head}<main>${stepNav(2)}<div class="card"><h1>בחירת מושבים</h1><p>בחרו ${b.pax} מושבים. שורות 1-3 (מסומנות) בתוספת $25.</p>
<form method="post" action="/trip/${b.id}/seats"><div class="seats">${rows}</div><input type="hidden" name="seats" id="seats">
<p class="muted" id="count">0 / ${b.pax}</p><button type="submit" id="next" disabled>המשך</button>
<button class="secondary" name="skip" value="1">דלג על בחירת מושבים</button></form></div></main>
<script>(function(){var n=${b.pax},sel=[];document.querySelectorAll('.seat').forEach(function(s){s.onclick=function(){var k=s.dataset.seat,i=sel.indexOf(k);
 if(i>=0){sel.splice(i,1);s.classList.remove('on')}else if(sel.length<n){sel.push(k);s.classList.add('on')}
 document.getElementById('seats').value=sel.join(',');document.getElementById('count').textContent=sel.length+' / '+n;document.getElementById('next').disabled=sel.length!==n}})})();</script>`,
      ),
    );
  });

  app.post("/trip/:bid/seats", async (c) => {
    const b = booking(c);
    if (!b) return c.redirect("/");
    const f = await c.req.parseBody();
    b.seats = f.skip
      ? []
      : String(f.seats ?? "")
          .split(",")
          .filter((s) => /^\d{1,2}[A-F]$/.test(s) && !takenSeat(b.offer.id, s))
          .slice(0, b.pax);
    lab.log("flights", "seats.chosen", { seats: b.seats });
    return c.redirect(`/trip/${b.id}/passengers`);
  });

  app.get("/trip/:bid/passengers", (c) => {
    const b = booking(c);
    if (!b) return c.redirect("/");
    const err = c.req.query("err");
    const paxForms = Array.from(
      { length: b.pax },
      (_, i) => `<fieldset class="card"><legend>נוסע ${i + 1}</legend>
<label>שם פרטי (באנגלית, כבדרכון)<input name="first${i}" required></label><label>שם משפחה (באנגלית)<input name="last${i}" required></label>
<label>מספר דרכון<input name="passport${i}" required></label><label>תאריך לידה<input name="dob${i}" type="date" required></label></fieldset>`,
    ).join("");
    return c.html(
      page(
        { title: "פרטי נוסעים", css: CSS },
        `${head}<main>${stepNav(3)}<h1>פרטי נוסעים</h1>${err ? `<div class="err" role="alert">${esc(err)}</div>` : ""}
<form method="post" action="/trip/${b.id}/passengers">${paxForms}<div class="card"><label>דואר אלקטרוני<input name="email" type="email" required></label>
<label>טלפון<input name="phone" type="tel" required></label></div><button>המשך לתשלום</button></form></main>`,
      ),
    );
  });

  app.post("/trip/:bid/passengers", async (c) => {
    const b = booking(c);
    if (!b) return c.redirect("/");
    const f = await c.req.parseBody();
    const passengers = Array.from({ length: b.pax }, (_, i) => ({
      first: String(f[`first${i}`] ?? "").trim(),
      last: String(f[`last${i}`] ?? "").trim(),
      passport: String(f[`passport${i}`] ?? "").trim(),
      dob: String(f[`dob${i}`] ?? ""),
    }));
    if (
      passengers.some(
        (p) =>
          !/^[A-Za-z' -]+$/.test(p.first) ||
          !/^[A-Za-z' -]+$/.test(p.last) ||
          p.passport.length < 6,
      )
    ) {
      return c.redirect(
        `/trip/${b.id}/passengers?err=${encodeURIComponent("השמות חייבים להיות באנגלית, ומספר הדרכון באורך 6 תווים לפחות.")}`,
      );
    }
    b.passengers = passengers;
    b.contact = { email: String(f.email ?? ""), phone: String(f.phone ?? "") };
    lab.log("flights", "passengers.submitted", {
      count: passengers.length,
      names: passengers.map((p) => `${p.first} ${p.last}`),
    });
    return c.redirect(`/trip/${b.id}/payment`);
  });

  app.get("/trip/:bid/payment", (c) => {
    const b = booking(c);
    if (!b?.passengers.length) return c.redirect("/");
    return c.html(
      page(
        { title: "תשלום", css: CSS },
        `${head}<main>${stepNav(4)}<div class="testmode">מצב בדיקה: לא יתבצע חיוב אמיתי. בכרטיס הבדיקה 4242 4242 4242 4242 אפשר להשתמש.</div>
<div class="card"><h1>סיכום ותשלום</h1><p>${esc(b.offer.airline)} ${b.offer.flightNo} · ${b.offer.from} → ${b.offer.to} · ${b.offer.date} ${b.offer.dep}</p>
<p>נוסעים: ${b.pax} × $${b.price}${b.seats.length ? ` · מושבים: ${b.seats.join(", ")} (+$${seatFees(b)})` : ""}</p>
<p class="price" data-testid="total">סה״כ: $${total(b)}</p>
<form method="post" action="/trip/${b.id}/payment"><label>מספר כרטיס<input name="card" inputmode="numeric" autocomplete="cc-number" required></label>
<label>שם בעל הכרטיס<input name="holder" required></label><label>תוקף (MM/YY)<input name="exp" placeholder="MM/YY" required></label>
<label>CVV<input name="cvv" inputmode="numeric" maxlength="4" required></label><p><button>אישור והזמנה</button></p></form></div></main>`,
      ),
    );
  });

  app.post("/trip/:bid/payment", async (c) => {
    const b = booking(c);
    if (!b?.passengers.length) return c.redirect("/");
    const f = await c.req.parseBody();
    const digits = String(f.card ?? "").replace(/\D/g, "");
    if (digits.length < 12)
      return c.html(
        page(
          { title: "תשלום", css: CSS },
          `${head}<main><div class="err" role="alert">מספר הכרטיס אינו תקין.</div><a href="/trip/${b.id}/payment">חזרה</a></main>`,
        ),
        400,
      );
    // Never charges anything: the card is reduced to its last four digits and discarded.
    b.paid = { last4: digits.slice(-4) };
    b.ref = `SKY${hash(b.id + b.offer.id)
      .toString(36)
      .toUpperCase()
      .slice(0, 5)}`;
    lab.log("flights", "payment.submitted", {
      bookingId: b.id,
      last4: b.paid.last4,
      total: total(b),
      offerId: b.offer.id,
    });
    lab.log("flights", "booking.confirmed", {
      ref: b.ref,
      offerId: b.offer.id,
      total: total(b),
      pax: b.pax,
    });
    return c.redirect(`/trip/${b.id}/confirmation`);
  });

  app.get("/trip/:bid/confirmation", (c) => {
    const b = booking(c);
    if (!b?.ref) return c.redirect("/");
    return c.html(
      page(
        { title: "אישור הזמנה", css: CSS },
        `${head}<main><div class="testmode">מצב בדיקה: ההזמנה לא אמיתית ולא בוצע חיוב.</div><div class="card"><h1>ההזמנה אושרה</h1>
<p>מספר הזמנה: <strong data-testid="booking-ref">${b.ref}</strong></p><p>${esc(b.offer.airline)} ${b.offer.flightNo} · ${b.offer.from} → ${b.offer.to} · ${b.offer.date} ${b.offer.dep}</p>
<p>סה״כ ששולם (בדיקה): $${total(b)} · כרטיס המסתיים ב-${b.paid?.last4}</p></div></main>`,
      ),
    );
  });

  return app;
}

function findOffer(offerId: string, from?: string, to?: string): Offer | undefined {
  const date = /-(\d{4}-\d{2}-\d{2})$/.exec(offerId)?.[1];
  if (!date || !from || !to) return undefined;
  return offersFor(from, to, date).find((o) => o.id === offerId);
}
