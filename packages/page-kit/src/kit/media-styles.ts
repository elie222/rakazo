import { pageKitPalette } from "@rakazo/ui-tokens";

export const MEDIA_CSS = `
:root{--rk-surface:${pageKitPalette.dark.cardSurface};--rk-card-shadow:0 1px 2px ${pageKitPalette.dark.cardShadowNear},0 6px 20px ${pageKitPalette.dark.cardShadowFar}}
[data-theme="light"]{--rk-surface:${pageKitPalette.light.cardSurface};--rk-card-shadow:0 1px 2px ${pageKitPalette.light.cardShadowNear},0 6px 20px ${pageKitPalette.light.cardShadowFar}}
.rk-figure{display:flex;flex-direction:column;gap:8px;min-width:0;margin:0;container-type:inline-size}
.rk-picture{position:relative;overflow:hidden;border-radius:16px;transition:background-color .3s}
@container (min-width:560px){.rk-figure>.rk-picture{border-radius:8px}}
.rk-picture[data-loading]{background:var(--rk-control)}
.rk-picture img,.rk-picture video{display:block;width:100%;height:100%;object-fit:cover;transition:opacity .3s}
.rk-picture[data-loading] img{opacity:0}
.rk-picture img[data-fit="contain"],.rk-picture video{object-fit:contain}
.rk-picture video[data-fit="cover"]{object-fit:cover}
.rk-picture[role="img"]{background:var(--rk-control)}
.rk-zoom>.rk-picture:not([style*="height"]):not([style*="aspect-ratio"]) img{height:auto}
.rk-zoom{display:block;width:100%;margin:0;padding:0;border:0;background:none;color:inherit;font:inherit;text-align:inherit;cursor:zoom-in;border-radius:16px}
@container (min-width:560px){.rk-zoom{border-radius:8px}.rk-zoom>.rk-picture{border-radius:8px}}
.rk-zoom:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
.rk-lightbox{position:fixed;inset:0;z-index:100;display:grid;place-items:center;padding:24px;background:color-mix(in srgb,var(--background) 92%,transparent);cursor:zoom-out;animation:rk-fade .18s ease-out}
.rk-lightbox img{max-width:100%;max-height:100%;border-radius:12px;object-fit:contain}
.rk-lightbox-close{position:absolute;top:12px;right:12px;display:grid;place-items:center;width:36px;height:36px;padding:0;border:0;border-radius:9999px;background:var(--rk-control);color:var(--foreground);cursor:pointer}
.rk-lightbox-close svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round}
.rk-lightbox-close:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
@keyframes rk-fade{from{opacity:0}}
.rk-gallery-track:focus-visible{outline:2px solid var(--ring);outline-offset:-2px}
.rk-figcaption{font-size:14px;line-height:20px;color:var(--rk-secondary)}
.rk-audio{display:block;width:100%;height:54px;border-radius:9999px}
.rk-gallery{position:relative;overflow:hidden;min-width:0}
.rk-gallery-track{display:flex;height:100%;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;overscroll-behavior-x:contain}
.rk-gallery-track::-webkit-scrollbar{display:none}
.rk-gallery-slide{margin:0;flex:none;width:100%;height:100%;scroll-snap-align:start}
.rk-gallery-slide .rk-picture{height:100%;border-radius:0}
.rk-gallery-slide>.rk-zoom{height:100%;border-radius:0}
.rk-gallery-slide>.rk-zoom:focus-visible{outline-offset:-2px}
.rk-gallery-arrow{position:absolute;top:50%;display:none;place-items:center;width:32px;height:32px;margin-top:-16px;padding:0;border:0;border-radius:9999px;background:${pageKitPalette.shared.onDeepTone};color:${pageKitPalette.shared.onTone};box-shadow:0 1px 3px ${pageKitPalette.shared.dotShadow};cursor:pointer;opacity:0;transition:opacity .14s}
.rk-gallery-arrow[data-way="previous"]{inset-inline-start:10px}
.rk-gallery-arrow[data-way="next"]{inset-inline-end:10px}
.rk-gallery-arrow svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
[dir="rtl"] .rk-gallery-arrow svg{transform:scaleX(-1)}
@media (hover:hover){.rk-gallery-arrow{display:grid}.rk-gallery:hover .rk-gallery-arrow{opacity:.92}.rk-gallery .rk-gallery-arrow:hover{opacity:1}}
.rk-gallery-dots{position:absolute;left:0;right:0;bottom:3px;display:flex;justify-content:center}
.rk-gallery-dots button{appearance:none;display:grid;place-items:center;width:24px;height:24px;margin:0 -6px;padding:0;border:0;background:none;cursor:pointer}
.rk-gallery-dots button::before{content:"";width:6px;height:6px;border-radius:6px;background:${pageKitPalette.shared.onDeepTone};opacity:.5;box-shadow:0 1px 3px ${pageKitPalette.shared.dotShadow};transition:opacity .14s,width .2s}
.rk-gallery-dots button[aria-current="true"]::before{width:14px;opacity:1}
.rk-gallery-dots button:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
.rk-strip{list-style:none;display:flex;gap:12px;margin:-18px 0 -30px;padding:18px 24px 30px 0;overflow-x:auto;scrollbar-width:none;scroll-snap-type:x proximity}
.rk-strip::-webkit-scrollbar{display:none}
.rk-strip>.rk-card{flex:none;scroll-snap-align:start}
.rk-card{display:flex;flex-direction:column;min-width:0;height:100%;overflow:hidden;border:1px solid color-mix(in srgb,var(--foreground) 5%,transparent);border-radius:22px;background:var(--rk-surface);box-shadow:var(--rk-card-shadow)}
.rk-card-link{display:flex;flex:1;flex-direction:column;color:inherit;text-decoration:none;border-radius:21.5px}
.rk-card-link:focus-visible{outline:2px solid var(--ring);outline-offset:-2px}
.rk-card-media{padding:6px 6px 0}
.rk-card-media .rk-gallery{border-radius:16px}
.rk-card-body{display:flex;flex:1;flex-direction:column;justify-content:space-between;padding:12px 14px 14px;min-width:0}
.rk-card-body[data-small]{padding:10px 12px 12px}
.rk-card-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.rk-card-heading{display:flex;align-items:flex-start;gap:8px}
.rk-card-title{flex:1;min-width:0;margin:0;font-size:14px;line-height:20px;font-weight:500;overflow-wrap:anywhere}
.rk-card-title[data-large]{font-size:16px;line-height:24px;font-weight:600}
.rk-badge{display:flex;flex:none;align-items:center;padding:2px 8px;border-radius:9999px;background:color-mix(in srgb,var(--rk-accent) 17%,transparent);color:var(--rk-accent);font-size:11px;line-height:16px;font-weight:500}
.rk-card-price{margin:0;font-size:14px;line-height:20px;color:var(--rk-secondary);overflow-wrap:anywhere}
.rk-card-price>span{color:var(--foreground);font-weight:500}
.rk-card-action{padding-top:12px}
.rk-card-action .rk-link-button{text-align:center}
.rk-store{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:4px;font-size:13px;line-height:18px;color:var(--rk-secondary)}
.rk-store-mark{display:flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:4px;background:var(--rk-control);font-size:11px;line-height:16px;font-weight:600}
.rk-stars{display:flex;gap:1px}
.rk-stars svg{display:block;width:12px;height:12px}
.rk-star-empty{fill:color-mix(in srgb,var(--foreground) 15%,transparent)}
.rk-star-full{fill:var(--rk-secondary)}
.rk-rating{display:flex;align-items:center;gap:10px}
.rk-rating-score{font-size:30px;line-height:36px;font-weight:600;font-variant-numeric:tabular-nums}
.rk-rating-detail{display:flex;flex-direction:column;gap:2px;font-size:13px;line-height:18px;color:var(--rk-secondary)}
.rk-product-rows{margin:0;padding:0;list-style:none;overflow:hidden;border:1px solid color-mix(in srgb,var(--foreground) 5%,transparent);border-radius:22px;background:var(--rk-surface);box-shadow:var(--rk-card-shadow)}
.rk-product-rows li+li .rk-product-row{border-top:1px solid color-mix(in srgb,var(--foreground) 10%,transparent);background-clip:padding-box}
.rk-product-row{display:flex;align-items:center;gap:12px;padding:12px 14px;color:inherit;text-decoration:none;transition:background-color .14s}
a.rk-product-row:hover{background:color-mix(in srgb,var(--foreground) 4%,transparent)}
a.rk-product-row:focus-visible{outline:2px solid var(--ring);outline-offset:-2px}
.rk-product-row>.rk-card-text{flex:1}
.rk-product-thumb{flex:none;width:56px;height:56px}
.rk-product-thumb .rk-picture{width:56px;height:56px;border-radius:8px}
.rk-row-chevron{flex:none;width:16px;height:16px;fill:none;stroke:var(--rk-tertiary);stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.rk-watch{display:flex;align-items:center;gap:12px;padding:14px 14px 14px 16px;border:1px solid color-mix(in srgb,var(--foreground) 5%,transparent);border-radius:22px;background:var(--rk-surface)}
.rk-watch-icon{display:grid;flex:none;place-items:center;width:30px;height:30px;border-radius:9999px;background:var(--rk-control)}
.rk-watch-icon svg{width:14px;height:14px;fill:none;stroke:var(--rk-secondary);stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round}
.rk-watch-text{flex:1;min-width:0}
.rk-watch-title{margin:0;font-size:14px;line-height:20px;font-weight:500;overflow-wrap:anywhere}
.rk-watch-detail{margin:0;font-size:12px;line-height:16px;color:var(--rk-secondary)}
.rk-watch>.rk-button{height:28px;padding:4px 12px;font-size:14px;line-height:20px}
.rk-card-grid,.rk-card-carousel{display:grid;gap:12px;align-items:stretch;grid-template-columns:repeat(auto-fill,minmax(max(200px,calc((100% - 36px) / 4)),1fr))}
.rk-card-carousel{grid-template-columns:repeat(auto-fill,minmax(max(280px,calc((100% - 24px) / 3)),1fr))}
.rk-card-carousel:focus-visible{outline:2px solid var(--ring);outline-offset:4px;border-radius:22px}
.rk-card-grid{margin:0;padding:0;list-style:none}
.rk-card-cell{display:grid;min-width:0;margin:0}
.rk-avatar{display:inline-flex;flex:none;align-items:center;justify-content:center;align-self:flex-start;border-radius:9999px;background:var(--rk-c1);color:${pageKitPalette.shared.onDeepTone};font-size:12px;line-height:16px;font-weight:500;user-select:none}
.rk-avatar[data-neutral]{background:var(--rk-control);color:var(--rk-secondary)}
.rk-avatar[data-more]{background:var(--rk-other)}
.rk-avatar-stack{display:flex;align-items:center;gap:16px;min-width:0}
.rk-avatars{display:flex;flex:none;padding-left:2px}
.rk-avatars>.rk-avatar{margin-right:-4px;border:1px solid var(--background)}
.rk-avatar-text{display:flex;flex-direction:column;min-width:0}
.rk-avatar-label{font-size:14px;line-height:20px;font-weight:500}
.rk-avatar-names{font-size:12px;line-height:16px;color:var(--rk-secondary)}
@media (max-width:640px){
.rk-card-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
.rk-card-carousel{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;margin:-18px -1rem -30px;padding:18px 1rem 30px;scroll-padding:0 1rem}
.rk-card-carousel>.rk-card-cell{flex:none;width:78%;scroll-snap-align:start}
}
@media (prefers-reduced-motion:reduce){.rk-lightbox{animation:none}.rk-picture,.rk-picture img,.rk-gallery-dots button::before,.rk-gallery-arrow{transition:none}.rk-gallery-track{scroll-behavior:auto}}
@media print{:root,[data-theme]{--rk-surface:${pageKitPalette.light.cardSurface};--rk-card-shadow:none}.rk-card,.rk-product-rows li,.rk-figure,.rk-watch{break-inside:avoid}.rk-gallery-dots,.rk-card-action{display:none}.rk-strip,.rk-card-carousel{flex-wrap:wrap;overflow:visible}}
`;
