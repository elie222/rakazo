export const message =
  "Do not register on ipcMain directly. List the channel in apps/desktop/src/main/ipc-channels.ts with the window whose page may call it, then answer it with handleIpc(channel, handler) from apps/desktop/src/main/ipc.ts: it refuses and reports any caller but that window's own page before the handler runs.";

export const include = ["apps/desktop/**/*.{ts,mts,cts,js,mjs,cjs}"];

export const exclude = ["apps/desktop/src/main/ipc.ts"];

export const pattern = /\bipcMain\s*\.\s*(?:handle|handleOnce|on|once|addListener)\s*\(/g;
