const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("rakazoSetup", {
  platform: process.platform,
  state: () => ipcRenderer.invoke("desktop.setup.state"),
  test: (url) => ipcRenderer.invoke("desktop.setup.test", url),
  save: (setup) => ipcRenderer.invoke("desktop.setup.save", setup),
  quit: () => ipcRenderer.invoke("desktop.setup.quit"),
  openLink: (link) => ipcRenderer.invoke("desktop.setup.openLink", link),
  stack: {
    state: () => ipcRenderer.invoke("desktop.setup.stack.state"),
    start: () => ipcRenderer.invoke("desktop.setup.stack.start"),
  },
});
