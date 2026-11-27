const { contextBridge, ipcRenderer } = require("electron");

// The shell of an installed page app. It passes the sandboxed frame's messages on unread; the
// main process checks each one. Channels are literals for ipc-channels.test.ts.
contextBridge.exposeInMainWorld("rakazoPageApp", {
  ready: () => ipcRenderer.invoke("desktop.pageApp.ready"),
  message: (data) => ipcRenderer.invoke("desktop.pageApp.message", data),
  onScreen: (listener) => {
    // The IpcRendererEvent stays in the preload: the shell only sees what to show.
    const handler = (_event, screen) => listener(screen);
    ipcRenderer.on("desktop.pageApp.screen", handler);
    return () => ipcRenderer.off("desktop.pageApp.screen", handler);
  },
});
