export const message =
  "Do not call rpc(...) from a mobile screen or component, build a caller with settingsRpc(...), or keep either under another name. Read with useQuery or useScreenQuery over rpcQuery / accountRpcQuery, and save with useSave, writing through the send its save receives, all from apps/mobile/lib/query.ts, so pending, errors and late answers are handled in one place. Convert the whole screen, never part of it.";

export const include = ["apps/mobile/{app,components}/**/*.{ts,tsx}"];

export const exclude = ["**/*.{test,spec}.*"];

// A call (also through a namespace, `api.rpc(`), a caller built for a settings target, an import
// alias, and `const call = rpc`.
export const pattern = /(?<![\w$])(?:rpc|settingsRpc)(?:\(|\s+as\s)|=\s*rpc\s*[;,)\n]/g;
