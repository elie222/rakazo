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
        setStatus(`Rakazo answered at ${result.url}.`, "ok");
      } else {
        setStatus(result.error ?? "Could not reach that address.", "error");
      }
      return result;
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

    const state = await bridge.state();
    localUrl.value = state.defaultLocalUrl;
    if (state.saved !== null) {
      const modeInput = document.querySelector(`input[name="mode"][value="${state.saved.mode}"]`);
      if (modeInput !== null) modeInput.checked = true;
      if (state.saved.mode === "existing") serverUrl.value = state.saved.serverUrl;
      else localUrl.value = state.saved.serverUrl;
    }
    syncPanels();
    activeField().focus();
  }

  void init();
})();
