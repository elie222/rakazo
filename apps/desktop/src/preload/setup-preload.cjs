const { contextBridge, ipcRenderer } = require("electron");

// A sandboxed preload can only require electron, so channels are named here as literals.
// ipc-channels.ts lists who may call each one; ipc-channels.test.ts fails when the two disagree.

contextBridge.exposeInMainWorld("rakazoSetup", {
  platform: process.platform,
  // Read before the page runs, so its first paint is already in the app's language.
  locale: ipcRenderer.sendSync("desktop.setup.locale") ?? { lang: "en", dir: "ltr", messages: {} },
  state: () => ipcRenderer.invoke("desktop.setup.state"),
  test: (url, headers) => ipcRenderer.invoke("desktop.setup.test", url, headers),
  save: (setup) => ipcRenderer.invoke("desktop.setup.save", setup),
  quit: () => ipcRenderer.invoke("desktop.setup.quit"),
  openLink: (link) => ipcRenderer.invoke("desktop.setup.openLink", link),
  stack: {
    state: () => ipcRenderer.invoke("desktop.setup.stack.state"),
    start: () => ipcRenderer.invoke("desktop.setup.stack.start"),
    onChange: (listener) => {
      ipcRenderer.on("desktop.setup.stack.changed", (_event, state) => listener(state));
    },
  },
});
