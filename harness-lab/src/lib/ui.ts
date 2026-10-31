import { esc } from "./core.js";

export interface PageOptions {
  title: string;
  lang?: "he" | "en";
  css?: string;
  head?: string;
  bodyClass?: string;
}

const BASE_CSS = `
*{box-sizing:border-box}body{margin:0;font-family:system-ui,"Segoe UI",Arial,sans-serif;background:#f4f6f8;color:#1c2733}
a{color:#0b5cad}header.top{display:flex;align-items:center;gap:16px;padding:12px 24px;background:var(--brand,#1d4e89);color:#fff}
header.top a{color:#fff;text-decoration:none}main{max-width:1000px;margin:24px auto;padding:0 16px}
.card{background:#fff;border:1px solid #d9e0e6;border-radius:8px;padding:16px;margin-bottom:16px}
button,.btn{background:var(--brand,#1d4e89);color:#fff;border:0;border-radius:6px;padding:9px 16px;font-size:15px;cursor:pointer;text-decoration:none;display:inline-block}
button.secondary,.btn.secondary{background:#e6ebf0;color:#1c2733}button:disabled{opacity:.5;cursor:not-allowed}
input,select{padding:8px;border:1px solid #9aa7b3;border-radius:6px;font-size:15px;width:100%;max-width:340px}
input[type=checkbox],input[type=radio]{width:auto}label{display:block;margin:10px 0 4px;font-weight:600}
table{border-collapse:collapse;width:100%;background:#fff}th,td{padding:8px 10px;border-bottom:1px solid #e1e6ea;text-align:start}
.err{color:#b00020;margin:8px 0}.ok{color:#0a7a3d}.muted{color:#66737f;font-size:14px}
.banner{position:fixed;inset-inline:0;bottom:0;background:#222;color:#fff;padding:14px 24px;display:flex;gap:16px;align-items:center;z-index:50}
.modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:60}
.modal{background:#fff;padding:24px;border-radius:10px;max-width:420px}
`;

export const cookieBanner = (text: string, accept: string) => `
<div class="banner" id="cookie-banner" role="dialog" aria-label="cookies"><span>${text}</span>
<button id="cookie-accept" type="button">${accept}</button></div>
<script>(function(){var b=document.getElementById('cookie-banner');if(document.cookie.indexOf('cc=1')>=0){b.remove();return}
document.getElementById('cookie-accept').onclick=function(){document.cookie='cc=1;path=/;max-age=31536000';b.remove()}})();</script>`;

export function page(opts: PageOptions, body: string): string {
  const lang = opts.lang ?? "he";
  return `<!doctype html><html lang="${lang}" dir="${lang === "he" ? "rtl" : "ltr"}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(opts.title)}</title>
<style>${BASE_CSS}${opts.css ?? ""}</style>${opts.head ?? ""}</head><body class="${opts.bodyClass ?? ""}">${body}</body></html>`;
}

export const shekel = (n: number) =>
  `${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₪`;
