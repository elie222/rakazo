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
import { afterEach, describe, expect, it } from "vitest";

const DEFAULT_LOCAL_URL = "http://127.0.0.1:6130";
const CLOUD_URL = "https://cloud.rakazo.example";

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
  /** The one `stack.start` call this mount can receive. */
  startResult: Deferred<DesktopLocalStackState>;
  /** Resolves the oldest pending `state` call, in call order. */
  resolveAppState: (saved: DesktopSetup | null) => void;
  /** Resolves the oldest pending `stack.state` call, in call order. */
  resolveStackState: (state: DesktopLocalStackState) => void;
  /** Delivers a pushed stack state the way the `desktop.setup.stack.changed` push does. */
  pushStackState: (state: DesktopLocalStackState) => void;
  /** Payloads received by `save`. */
  saves: DesktopSetup[];
}

function mount(saved: DesktopSetup | null): Harness {
  document.body.innerHTML = setupBody ?? "";
  const checkCalls: Array<Deferred<DesktopReachability>> = [];
  const startResult = deferred<DesktopLocalStackState>();
  const stateCalls: Array<Deferred<DesktopSetupState>> = [];
  const stackStateCalls: Array<Deferred<DesktopLocalStackState>> = [];
  const pushListeners: Array<(state: DesktopLocalStackState) => void> = [];
  const saves: DesktopSetup[] = [];

  const bridge: RakazoSetup = {
    platform: "linux",
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
      return Promise.resolve({ ok: true });
    },
    quit: () => Promise.resolve(),
    openLink: () => Promise.resolve(),
    stack: {
      state: () => {
        const call = deferred<DesktopLocalStackState>();
        stackStateCalls.push(call);
        return call.promise;
      },
      start: () => startResult.promise,
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
    resolveAppState: (next) =>
      stateCalls
        .shift()
        ?.resolve({ defaultLocalUrl: DEFAULT_LOCAL_URL, cloudUrl: CLOUD_URL, saved: next }),
    resolveStackState: (state) => stackStateCalls.shift()?.resolve(state),
    pushStackState: (state) => {
      for (const listener of pushListeners) listener(state);
    },
    saves,
  };
}

/** Loads the page and lets init settle on an idle stack. */
async function boot(saved: DesktopSetup | null): Promise<Harness> {
  const ui = mount(saved);
  await flush(); // init reaches its stack.state call only after its state await resumes
  ui.resolveStackState(stackState("idle"));
  await flush();
  expect(element<HTMLButtonElement>("continue").disabled).toBe(false);
  return ui;
}

describe("setup", () => {
  afterEach(() => {
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

    expect(element("stack-phase").textContent).toBe("Rakazo is ready.");
    expect(element("stack-phase").getAttribute("data-tone")).toBe("ok");
    expect(ui.saves).toEqual([{ mode: "new", serverUrl: DEFAULT_LOCAL_URL }]);
    expect(element<HTMLButtonElement>("continue").disabled).toBe(false);
  });
});
