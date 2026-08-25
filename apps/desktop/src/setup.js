(() => {
  const bridge = window.rakazoSetup;

  const form = document.getElementById("setup");
  const localUrl = document.getElementById("local-url");
  const serverUrl = document.getElementById("server-url");
  const panelNew = document.getElementById("panel-new");
  const panelExisting = document.getElementById("panel-existing");
  const status = document.getElementById("status");
  const checkButton = document.getElementById("check");
  const continueButton = document.getElementById("continue");
  const quitButton = document.getElementById("quit");

  function selectedMode() {
    const checked = form.querySelector('input[name="mode"]:checked');
    return checked === null ? "new" : checked.value;
  }

  function activeField() {
    return selectedMode() === "new" ? localUrl : serverUrl;
  }

  function setStatus(message, tone) {
    status.textContent = message;
    if (tone === undefined) status.removeAttribute("data-tone");
    else status.setAttribute("data-tone", tone);
  }

  function setBusy(busy) {
    checkButton.disabled = busy;
    continueButton.disabled = busy;
  }

  function syncPanels() {
    const mode = selectedMode();
    panelNew.hidden = mode !== "new";
    panelExisting.hidden = mode === "new";
    setStatus("");
  }

  async function check() {
    const value = activeField().value;
    if (value.trim() === "") {
      setStatus("Enter a server address first.", "error");
      return null;
    }

    setBusy(true);
    setStatus("Checking…");
    try {
      const result = await bridge.test(value);
      if (result.ok) {
        activeField().value = result.url;
        setStatus(`Rakazo answered at ${result.url}.`, "ok");
      } else {
        setStatus(result.error ?? "Could not reach that address.", "error");
      }
      return result;
    } catch {
      setStatus("Could not run the connection check. Try again.", "error");
      return null;
    } finally {
      setBusy(false);
    }
  }

  form.addEventListener("change", (event) => {
    if (event.target instanceof HTMLInputElement && event.target.name === "mode") syncPanels();
  });

  checkButton.addEventListener("click", () => {
    void check();
  });

  quitButton.addEventListener("click", () => {
    if (bridge === undefined) {
      window.close();
      return;
    }
    void bridge.quit();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const mode = selectedMode();
    const value = activeField().value;

    setBusy(true);
    setStatus("Connecting…");
    try {
      const saved = await bridge.save({ mode, serverUrl: value });
      if (!saved.ok) setStatus(saved.error ?? "Could not save that address.", "error");
    } catch {
      setStatus("Could not save that address. Try again.", "error");
    } finally {
      setBusy(false);
    }
  });

  async function init() {
    if (bridge === undefined) {
      setStatus("Setup bridge unavailable.", "error");
      setBusy(true);
      return;
    }

    try {
      const state = await bridge.state();
      if (state === null) throw new Error("Setup is not active");
      localUrl.value = state.defaultLocalUrl;
      if (state.saved !== null) {
        const modeInput = document.querySelector(`input[name="mode"][value="${state.saved.mode}"]`);
        if (modeInput !== null) modeInput.checked = true;
        if (state.saved.mode === "existing") serverUrl.value = state.saved.serverUrl;
        else localUrl.value = state.saved.serverUrl;
      }
      syncPanels();
      if (state.error) setStatus(state.error, "error");
      activeField().focus();
    } catch {
      setStatus("Setup could not start. Quit Rakazo and try again.", "error");
      setBusy(true);
    }
  }

  void init();
})();
