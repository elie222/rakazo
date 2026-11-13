// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  DesktopLocalStackState,
  DesktopReachability,
  DesktopSetup,
  DesktopSetupState,
  RakazoSetup,
} from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ES_MESSAGES } from "./locales/es.js";
import { HE_MESSAGES } from "./locales/he.js";
import { PL_MESSAGES } from "./locales/pl.js";

type DesktopSetupResult = Awaited<ReturnType<RakazoSetup["save"]>>;

const DEFAULT_LOCAL_URL = "http://127.0.0.1:6130";
const CLOUD_URL = "https://cloud.rakazo.example";
const ENGLISH: RakazoSetup["locale"] = { lang: "en", dir: "ltr", messages: {} };

// The jsdom environment replaces the global URL, so resolve the sibling files via Node's.
const srcDir = path.dirname(fileURLToPath(import.meta.url));
const setupBody = readFileSync(path.join(srcDir, "setup.html"), "utf8").match(
  /<body>([\s\S]*)<\/body>/,
)?.[1];
const setupScript = readFileSync(path.join(srcDir, "setup.js"), "utf8");

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function stackState(phase: DesktopLocalStackState["phase"]): DesktopLocalStackState {
  return { phase, message: null, output: [], layerBytes: {}, imageTag: "v0.0.0" };
}

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`setup.html is missing #${id}`);
  return node as T;
}

/** Pumps the microtask queue so the script's await chains advance without timers. */
async function flush(ticks = 30): Promise<void> {
  for (let i = 0; i < ticks; i += 1) await Promise.resolve();
}

function selectMode(mode: "cloud" | "new" | "existing"): void {
  const input = document.querySelector<HTMLInputElement>(`input[name="mode"][value="${mode}"]`);
  if (input === null) throw new Error(`setup.html is missing the ${mode} mode input`);
  input.checked = true;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function submitForm(): void {
  element<HTMLFormElement>("setup").dispatchEvent(
    new Event("submit", { bubbles: true, cancelable: true }),
  );
}

interface Harness {
  /** The oldest pending `test` call's deferred, for settling one check by handle. */
  nextCheck: () => Deferred<DesktopReachability>;
  /** Resolves the oldest pending `test` call, in call order. */
  resolveCheck: (result: DesktopReachability) => void;
  /** What every `stack.start` call this mount receives resolves with. */
  startResult: Deferred<DesktopLocalStackState>;
  /** How many times `stack.start` was called. */
  starts: () => number;
  /** Links passed to `openLink`. */
  links: string[];
  /** Resolves the oldest pending `state` call, in call order. */
  resolveAppState: (saved: DesktopSetup | null) => void;
  /** Resolves the oldest pending `stack.state` call, in call order. */
  resolveStackState: (state: DesktopLocalStackState) => void;
  /** Rejects the oldest pending `stack.state` call. */
  rejectStackState: (reason: unknown) => void;
  /** Delivers a pushed stack state the way the `desktop.setup.stack.changed` push does. */
  pushStackState: (state: DesktopLocalStackState) => void;
  /** Payloads received by `save`. */
  saves: DesktopSetup[];
  /** Resolves the oldest pending `save` call, in call order. */
  resolveSave: (result: DesktopSetupResult) => void;
}

function mount(saved: DesktopSetup | null, locale = ENGLISH, platform = "linux"): Harness {
  document.body.innerHTML = setupBody ?? "";
  const checkCalls: Array<Deferred<DesktopReachability>> = [];
  const startResult = deferred<DesktopLocalStackState>();
  const stateCalls: Array<Deferred<DesktopSetupState>> = [];
  const stackStateCalls: Array<Deferred<DesktopLocalStackState>> = [];
  const pushListeners: Array<(state: DesktopLocalStackState) => void> = [];
  const saves: DesktopSetup[] = [];
  const saveCalls: Array<Deferred<DesktopSetupResult>> = [];
  const links: string[] = [];
  let starts = 0;

  const bridge: RakazoSetup = {
    platform,
    locale,
    state: () => {
      const call = deferred<DesktopSetupState>();
      stateCalls.push(call);
      return call.promise;
    },
    test: () => {
      const call = deferred<DesktopReachability>();
      checkCalls.push(call);
      return call.promise;
    },
    save: (setup) => {
      saves.push(setup);
      const call = deferred<DesktopSetupResult>();
      saveCalls.push(call);
      return call.promise;
    },
    quit: () => Promise.resolve(),
    openLink: (link) => {
      links.push(link);
      return Promise.resolve();
    },
    stack: {
      state: () => {
        const call = deferred<DesktopLocalStackState>();
        stackStateCalls.push(call);
        return call.promise;
      },
      start: () => {
        starts += 1;
        return startResult.promise;
      },
      onChange: (listener) => {
        pushListeners.push(listener);
      },
    },
  };
  (window as { rakazoSetup?: RakazoSetup }).rakazoSetup = bridge;
  // Run the plain script the same way setup.html's script tag does.
  new Function(setupScript)();

  const initState = stateCalls.shift();
  initState?.resolve({ defaultLocalUrl: DEFAULT_LOCAL_URL, cloudUrl: CLOUD_URL, saved });
  return {
    nextCheck: () => {
      const call = checkCalls.shift();
      if (call === undefined) throw new Error("no connection check is pending");
      return call;
    },
    resolveCheck: (result) => checkCalls.shift()?.resolve(result),
    startResult,
    starts: () => starts,
    links,
    resolveAppState: (next) =>
      stateCalls
        .shift()
        ?.resolve({ defaultLocalUrl: DEFAULT_LOCAL_URL, cloudUrl: CLOUD_URL, saved: next }),
    resolveStackState: (state) => stackStateCalls.shift()?.resolve(state),
    rejectStackState: (reason) => stackStateCalls.shift()?.reject(reason),
    pushStackState: (state) => {
      for (const listener of pushListeners) listener(state);
    },
    saves,
    resolveSave: (result) => saveCalls.shift()?.resolve(result),
  };
}

/** Loads the page and lets init settle on an idle stack. */
async function boot(
  saved: DesktopSetup | null,
  locale = ENGLISH,
  platform = "linux",
): Promise<Harness> {
  const ui = mount(saved, locale, platform);
  await flush(); // init reaches its stack.state call only after its state await resumes
  ui.resolveStackState(stackState("idle"));
  await flush();
  expect(element<HTMLButtonElement>("continue").disabled).toBe(false);
  return ui;
}

describe("setup", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
    delete (window as { rakazoSetup?: RakazoSetup }).rakazoSetup;
  });

  it("keeps an address edited while the connection check is pending", async () => {
    const ui = await boot({ mode: "existing", serverUrl: "https://one.example" });
    element<HTMLButtonElement>("check").click();
    await flush();
    expect(element("status").textContent).toBe("Checking…");

    element<HTMLInputElement>("server-url").value = "https://two.example";
    element<HTMLInputElement>("server-url").dispatchEvent(new Event("input"));
    ui.resolveCheck({ ok: true, url: "https://normalized.example" });
    await flush();

    expect(element<HTMLInputElement>("server-url").value).toBe("https://two.example");
    expect(element("status").textContent).toBe("");
    expect(element<HTMLButtonElement>("continue").disabled).toBe(false);
    expect(element<HTMLButtonElement>("check").disabled).toBe(false);
  });

  it("keeps a newer check busy when a stale check settles after it starts", async () => {
    const ui = await boot(null);
    selectMode("existing");
    await flush();
    const field = element<HTMLInputElement>("server-url");
    field.value = "one.example";
    element<HTMLButtonElement>("check").click();
    const staleCheck = ui.nextCheck();
    await flush();

    field.value = "two.example";
    field.dispatchEvent(new Event("input"));
    await flush();
    expect(element<HTMLButtonElement>("continue").disabled).toBe(false);

    element<HTMLButtonElement>("check").click();
    const currentCheck = ui.nextCheck();
    await flush();
    expect(element<HTMLButtonElement>("check").disabled).toBe(true);
    expect(element<HTMLButtonElement>("continue").disabled).toBe(true);
    expect(element("status").textContent).toBe("Checking…");

    // The retired check settles last; its stale success must not touch the newer check's state.
    staleCheck.resolve({ ok: true, url: "https://one.example" });
    await flush();
    expect(field.value).toBe("two.example");
    expect(element("status").textContent).toBe("Checking…");
    expect(element<HTMLButtonElement>("check").disabled).toBe(true);
    expect(element<HTMLButtonElement>("continue").disabled).toBe(true);

    currentCheck.resolve({ ok: true, url: "https://two.example" });
    await flush();
    expect(field.value).toBe("https://two.example");
    expect(element("status").textContent).toBe("Rakazo answered at https://two.example.");
    expect(element("status").getAttribute("data-tone")).toBe("ok");
    expect(element<HTMLButtonElement>("check").disabled).toBe(false);
    expect(element<HTMLButtonElement>("continue").disabled).toBe(false);
  });

  it("ignores a start that finishes after leaving This computer", async () => {
    const ui = await boot(null);
    selectMode("new");
    submitForm();
    await flush();
    expect(element<HTMLButtonElement>("continue").disabled).toBe(true);

    selectMode("cloud");
    await flush();
    expect(element<HTMLButtonElement>("continue").disabled).toBe(false);

    ui.startResult.resolve(stackState("starting"));
    await flush();
    expect(element<HTMLButtonElement>("continue").disabled).toBe(false);
    expect(element("stack").hidden).toBe(true);
    expect(element("stack-phase").textContent).toBe("");
  });

  it("stays silent when a start fails after leaving This computer", async () => {
    const ui = await boot(null);
    selectMode("new");
    submitForm();
    await flush();
    selectMode("cloud");
    await flush();

    ui.startResult.reject(new Error("renderer closed"));
    await flush();

    expect(element("status").textContent).toBe("");
    expect(element<HTMLButtonElement>("continue").disabled).toBe(false);
  });

  it("re-attaches to the running stack after returning to This computer", async () => {
    const ui = await boot(null);
    selectMode("new");
    submitForm();
    await flush();
    selectMode("cloud");
    await flush();
    ui.startResult.resolve(stackState("starting"));
    await flush();

    selectMode("new");
    await flush();
    ui.pushStackState(stackState("pulling"));
    await flush();
    ui.resolveStackState(stackState("pulling"));
    await flush();

    expect(element("stack").hidden).toBe(false);
    expect(element("stack-phase").textContent).toBe("Downloading Rakazo…");
  });

  it("locks the address while it is being saved and unlocks it when the save fails", async () => {
    const ui = await boot(null);
    selectMode("existing");
    await flush();
    const field = element<HTMLInputElement>("server-url");
    field.value = "https://one.example";
    submitForm();
    await flush();

    expect(ui.saves).toEqual([{ mode: "existing", serverUrl: "https://one.example", headers: {} }]);
    expect(field.disabled).toBe(true);
    // Headers saved with this address must not change while the save is pending.
    expect(element<HTMLTextAreaElement>("server-headers").disabled).toBe(true);

    ui.resolveSave({ ok: false, error: "Server did not answer." });
    await flush();
    expect(field.disabled).toBe(false);
    expect(element<HTMLTextAreaElement>("server-headers").disabled).toBe(false);
    expect(element("status").textContent).toBe("Server did not answer.");
  });

  it("gives the address its focus back when a save started from it fails", async () => {
    const ui = await boot(null);
    selectMode("existing");
    await flush();
    const field = element<HTMLInputElement>("server-url");
    field.value = "https://one.example";
    field.focus();
    submitForm();
    await flush();
    // Browsers drop focus from a control that becomes disabled; jsdom keeps it, so drop it here.
    expect(field.disabled).toBe(true);
    field.disabled = false;
    field.blur();
    field.disabled = true;
    expect(document.activeElement).toBe(document.body);

    ui.resolveSave({ ok: false, error: "Server did not answer." });
    await flush();
    expect(document.activeElement).toBe(field);
  });

  it("normalizes the address and reports success for the current check", async () => {
    const ui = await boot(null);
    selectMode("existing");
    await flush();
    element<HTMLInputElement>("server-url").value = "one.example";
    element<HTMLButtonElement>("check").click();
    ui.resolveCheck({ ok: true, url: "https://one.example" });
    await flush();

    expect(element<HTMLInputElement>("server-url").value).toBe("https://one.example");
    expect(element("status").textContent).toBe("Rakazo answered at https://one.example.");
    expect(element("status").getAttribute("data-tone")).toBe("ok");
    expect(element<HTMLButtonElement>("check").disabled).toBe(false);
  });

  it("reports a failed current check", async () => {
    const ui = await boot(null);
    selectMode("existing");
    await flush();
    element<HTMLInputElement>("server-url").value = "https://down.example";
    element<HTMLButtonElement>("check").click();
    ui.resolveCheck({ ok: false, error: "Server did not answer." });
    await flush();

    expect(element("status").textContent).toBe("Server did not answer.");
    expect(element("status").getAttribute("data-tone")).toBe("error");
    expect(element<HTMLButtonElement>("check").disabled).toBe(false);
  });

  it("shows saved headers and saves them with the existing server", async () => {
    const headers = { "CF-Access-Client-Id": "id.access", "CF-Access-Client-Secret": "secret" };
    const ui = await boot({ mode: "existing", serverUrl: "https://one.example", headers });
    expect(element<HTMLDetailsElement>("server-headers-section").open).toBe(true);
    expect(element<HTMLTextAreaElement>("server-headers").value).toBe(
      "CF-Access-Client-Id: id.access\nCF-Access-Client-Secret: secret",
    );

    submitForm();
    await flush();

    expect(ui.saves).toEqual([{ mode: "existing", serverUrl: "https://one.example", headers }]);
  });

  it("refuses a header line without a name before saving", async () => {
    const ui = await boot({ mode: "existing", serverUrl: "https://one.example" });
    element<HTMLTextAreaElement>("server-headers").value = ": value";

    submitForm();
    await flush();

    expect(ui.saves).toEqual([]);
    expect(element("status").textContent).toBe("Invalid custom headers");
  });

  it("renders a current start and follows it until it saves the ready stack", async () => {
    const ui = await boot(null);
    selectMode("new");
    submitForm();
    ui.startResult.resolve(stackState("pulling"));
    await flush();
    expect(element("stack").hidden).toBe(false);
    expect(element("stack-phase").textContent).toBe("Downloading Rakazo…");
    expect(element<HTMLButtonElement>("continue").disabled).toBe(true);

    ui.resolveStackState(stackState("ready"));
    await flush();
    ui.resolveAppState(null);
    await flush();
    ui.resolveSave({ ok: true });
    await flush();

    expect(element("stack-phase").textContent).toBe("Rakazo is ready.");
    expect(element("stack-phase").getAttribute("data-tone")).toBe("ok");
    expect(ui.saves).toEqual([{ mode: "new", serverUrl: DEFAULT_LOCAL_URL }]);
    expect(element<HTMLButtonElement>("continue").disabled).toBe(false);
  });

  it("offers the Docker Desktop download as a next step, not an error", async () => {
    const ui = await boot(null, ENGLISH, "darwin");
    selectMode("new");
    submitForm();
    const missing = {
      ...stackState("docker-missing"),
      message: "Rakazo needs Docker Desktop to run on this computer.",
    };
    ui.startResult.resolve(missing);
    await flush();
    ui.resolveStackState(missing);
    await flush();

    expect(element("stack-phase").textContent).toBe(missing.message);
    expect(element("stack-phase").hasAttribute("data-tone")).toBe(false);
    expect(element("stack-hint").hidden).toBe(false);
    expect(element("stack-waiting").hidden).toBe(false);
    expect(element("stack-waiting").textContent).toContain("Waiting for Docker Desktop…");
    expect(element("continue").textContent).toBe("Download Docker Desktop");
    expect(element<HTMLButtonElement>("continue").disabled).toBe(false);

    submitForm();
    await flush();
    expect(ui.links).toEqual(["docker-download"]);
    expect(ui.starts()).toBe(1);
  });

  it("keeps looking for Docker in the background and moves on once it answers", async () => {
    vi.useFakeTimers();
    const ui = await boot(null, ENGLISH, "darwin");
    selectMode("new");
    submitForm();
    const missing = { ...stackState("docker-missing"), message: "Rakazo needs Docker Desktop." };
    ui.startResult.resolve(missing);
    await flush();
    ui.resolveStackState(missing);
    await flush();
    expect(ui.starts()).toBe(1);

    vi.advanceTimersByTime(3000);
    await flush();
    expect(ui.starts()).toBe(2);
    // The look itself does not replace the waiting view or lock the download button.
    ui.pushStackState(stackState("checking-docker"));
    ui.resolveStackState(stackState("checking-docker"));
    await flush();
    expect(element("stack-phase").textContent).toBe(missing.message);
    expect(element<HTMLButtonElement>("continue").disabled).toBe(false);

    vi.advanceTimersByTime(1000);
    await flush();
    ui.resolveStackState(stackState("preparing"));
    await flush();
    expect(element("stack-phase").textContent).toBe("Getting ready…");
    expect(element("stack-waiting").hidden).toBe(true);
    expect(element<HTMLButtonElement>("continue").disabled).toBe(true);
  });

  it("keeps looking for Docker after a background look fails to read the stack", async () => {
    vi.useFakeTimers();
    const ui = await boot(null, ENGLISH, "darwin");
    selectMode("new");
    submitForm();
    const missing = { ...stackState("docker-missing"), message: "Rakazo needs Docker Desktop." };
    ui.startResult.resolve(missing);
    await flush();
    ui.resolveStackState(missing);
    await flush();

    vi.advanceTimersByTime(3000);
    await flush();
    expect(ui.starts()).toBe(2);
    ui.rejectStackState(new Error("Setup is not active"));
    await flush();

    vi.advanceTimersByTime(3000);
    await flush();
    expect(ui.starts()).toBe(3);
  });

  // The follow may be waiting on the stack, or reading the app's state after the stack became
  // ready, when the person switches to an existing instance.
  for (const leaveAfterReady of [false, true]) {
    it(`saves nothing when This computer is left ${leaveAfterReady ? "after the stack became ready" : "before the stack is ready"}`, async () => {
      const ui = await boot(null);
      selectMode("new");
      submitForm();
      ui.startResult.resolve(stackState("pulling"));
      await flush();
      expect(element("stack-phase").textContent).toBe("Downloading Rakazo…");

      if (leaveAfterReady) {
        ui.resolveStackState(stackState("ready"));
        await flush();
      }
      selectMode("existing");
      await flush();
      // Answer every read a follow could still make, so a save it would start has started.
      for (let round = 0; round < 3; round += 1) {
        ui.pushStackState(stackState("ready"));
        ui.resolveStackState(stackState("ready"));
        await flush();
        ui.resolveAppState(null);
        await flush();
      }

      expect(ui.saves).toEqual([]);
      expect(element<HTMLButtonElement>("continue").disabled).toBe(false);
    });
  }

  it("lays a right-to-left language out right to left", async () => {
    await boot(null, { lang: "he", dir: "rtl", messages: HE_MESSAGES });
    expect(document.documentElement.lang).toBe("he");
    expect(document.documentElement.dir).toBe("rtl");
    expect(element("continue").textContent).toBe(HE_MESSAGES.Continue);
  });

  it("renders the page and its messages in the app's language", async () => {
    const ui = await boot(null, { lang: "es", dir: "ltr", messages: ES_MESSAGES });
    expect(document.documentElement.lang).toBe("es");
    expect(document.documentElement.dir).toBe("ltr");
    expect(document.querySelector("h1")?.textContent).toBe("Te damos la bienvenida a Rakazo");
    expect(document.querySelector('label[for="mode-new"] .choice-title')?.textContent).toBe(
      "Esta computadora",
    );
    expect(document.querySelector('label[for="mode-new"] .choice-description')?.textContent).toBe(
      "Tus datos se quedan en esta computadora.",
    );
    expect(document.querySelector('label[for="mode-cloud"] .choice-title')?.textContent).toBe(
      "Rakazo Cloud",
    );
    expect(element("quit").textContent).toBe("Salir");
    expect(element("quit").title).toBe("Salir de Rakazo");
    expect(element("stack-details").getAttribute("aria-label")).toBe("Detalles técnicos");
    expect(element<HTMLTextAreaElement>("server-headers").placeholder).toBe("Nombre: valor");
    expect(element("continue").textContent).toBe("Continuar");

    selectMode("existing");
    await flush();
    element<HTMLInputElement>("server-url").value = "one.example";
    element<HTMLButtonElement>("check").click();
    await flush();
    expect(element("status").textContent).toBe("Comprobando…");
    ui.resolveCheck({ ok: true, url: "https://one.example" });
    await flush();
    expect(element("status").textContent).toBe("Rakazo respondió en https://one.example.");

    selectMode("new");
    submitForm();
    ui.startResult.resolve({ ...stackState("pulling"), layerBytes: { layer: 2.5e6 } });
    await flush();
    expect(element("stack-phase").textContent).toBe("Descargando Rakazo…");
    expect(element("stack-detail").textContent).toBe("3 MB descargados");
  });

  it("renders Polish setup controls and interpolates connection and download status", async () => {
    const ui = await boot(null, { lang: "pl", dir: "ltr", messages: PL_MESSAGES });
    expect(document.documentElement.lang).toBe("pl");
    expect(document.documentElement.dir).toBe("ltr");
    expect(document.querySelector("h1")?.textContent).toBe("Witaj w Rakazo");
    expect(element("continue").textContent).toBe(PL_MESSAGES.Continue);
    expect(element("stack-details").getAttribute("aria-label")).toBe(
      PL_MESSAGES["Technical details"],
    );
    expect(element<HTMLTextAreaElement>("server-headers").placeholder).toBe(
      PL_MESSAGES["Name: value"],
    );

    selectMode("existing");
    await flush();
    element<HTMLInputElement>("server-url").value = "one.example";
    element<HTMLButtonElement>("check").click();
    await flush();
    expect(element("status").textContent).toBe(PL_MESSAGES["Checking…"]);
    ui.resolveCheck({ ok: true, url: "https://one.example" });
    await flush();
    expect(element("status").textContent).toBe(
      "Rakazo odpowiedziało pod adresem https://one.example.",
    );

    selectMode("new");
    submitForm();
    ui.startResult.resolve({ ...stackState("pulling"), layerBytes: { layer: 2.5e6 } });
    await flush();
    expect(element("stack-phase").textContent).toBe(PL_MESSAGES["Downloading Rakazo…"]);
    expect(element("stack-detail").textContent).toBe("Pobrano 3 MB");
  });
});
