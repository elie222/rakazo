export const message =
  "Do not call rpc(...) from a mobile screen or component. Read with useQuery or useScreenQuery over rpcQuery / accountRpcQuery, and save with useSave sending rpcSave(...), all from apps/mobile/lib/query.ts, so pending, errors and late answers are handled in one place. Convert the whole screen, never part of it.";

export const include = ["apps/mobile/{app,components}/**/*.{ts,tsx}"];

export const exclude = ["**/*.{test,spec}.*"];

export const pattern = /(?<![\w.$])rpc\(/g;
