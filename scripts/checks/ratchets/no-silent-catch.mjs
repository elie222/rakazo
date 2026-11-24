export const message =
  'Do not discard a rejection silently. When the failure really is ignorable, use bestEffort("<what was attempted>", promise) from @rakazo/logging (@rakazo/logging/best-effort in mobile and web code), which logs it; if the caller needs to know it failed, handle or propagate the error.';

export const include = [
  "{packages/{adapters,db,auth,memory},apps/{api,worker},infra/sandboxes/supervisor,infra/updater}/src/**/*.{ts,tsx,mts,js,mjs}",
  "{apps/{web/src,mobile},packages/{chat-ui,ui-web,page-kit}/src}/**/*.{ts,tsx}",
];

export const exclude = ["**/*.{test,spec}.*", "**/*test-support*", "**/e2e/**"];

export const pattern =
  /\.catch\(\s*(?:async\s*)?\(\s*\w*\s*\)\s*=>\s*(?:undefined|null|false|void 0|\{\s*\}|\[\])\s*,?\s*\)/g;
