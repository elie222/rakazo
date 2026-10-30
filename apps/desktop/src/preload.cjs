const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("rakazoDesktop", {
  platform: process.platform,
  nativeWindowFrame: process.platform === "win32",
  badge: {
    set: (count) => ipcRenderer.invoke("desktop.badge.set", count),
  },
  computer: {
    managesHostChoice: true,
    requestAccess: () => ipcRenderer.invoke("desktop.computer.requestAccess"),
    revokeAccess: () => ipcRenderer.invoke("desktop.computer.revokeAccess"),
    onConfigure: (listener) => {
      const handler = () => listener();
      ipcRenderer.on("desktop.computer.configure", handler);
      return () => ipcRenderer.off("desktop.computer.configure", handler);
    },
  },
  device: {
    state: () => ipcRenderer.invoke("desktop.device.state"),
    setAllowed: (allowed) => ipcRenderer.invoke("desktop.device.setAllowed", allowed),
  },
  monitoring: {
    enabled: () => ipcRenderer.invoke("desktop.monitoring.enabled"),
  },
  passkeys: {
    rpIds: () => ipcRenderer.invoke("desktop.passkeys.rpIds"),
  },
  // Only macOS ships a system recognizer helper; elsewhere dictation keeps its provider path.
  ...(process.platform === "darwin"
    ? {
        speech: {
          start: (language, session) =>
            ipcRenderer.invoke("desktop.speech.start", language, session),
          stop: (session) => ipcRenderer.invoke("desktop.speech.stop", session),
          abort: (session) => ipcRenderer.invoke("desktop.speech.abort", session),
          onEvent: (listener) => {
            // The IpcRendererEvent stays in the preload: the renderer only sees the payload.
            const handler = (_event, payload) => listener(payload);
            ipcRenderer.on("desktop.speech.event", handler);
            return () => ipcRenderer.off("desktop.speech.event", handler);
          },
        },
      }
    : {}),
  window: {
    close: () => ipcRenderer.invoke("desktop.window.close"),
    minimize: () => ipcRenderer.invoke("desktop.window.minimize"),
    toggleMaximize: () => ipcRenderer.invoke("desktop.window.toggleMaximize"),
    state: () => ipcRenderer.invoke("desktop.window.state"),
  },
  update: {
    state: () => ipcRenderer.invoke("desktop.update.state"),
    check: () => ipcRenderer.invoke("desktop.update.check"),
    download: () => ipcRenderer.invoke("desktop.update.download"),
    install: () => ipcRenderer.invoke("desktop.update.install"),
  },
  oauth: {
    open: (url) => ipcRenderer.invoke("desktop.oauth.open", url),
    cancel: (url) => ipcRenderer.invoke("desktop.oauth.cancel", url),
    onCallback: (listener) => {
      // The IpcRendererEvent stays in the preload: the renderer only sees the code.
      const handler = (_event, callback) => listener(callback);
      ipcRenderer.on("desktop.oauth.callback", handler);
      return () => ipcRenderer.off("desktop.oauth.callback", handler);
    },
  },
});
