import type { AdapterContext, BrowserPasskey, ComputerRef } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { ComputerBrowserProvider } from "../computers/screens/computer-browser.js";
import type { ResolvePasskey } from "./browser-tools.js";
import { browserActFromTool, parseBrowserActions } from "./browser-tools.js";
import { FakeBrowserProvider } from "./fake-browser.js";

const context: AdapterContext = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};
const computer: ComputerRef = { id: "c1", botId: "b1", kind: "fake", providerRef: "c1" };
const origin = "https://portal.example.test";
const PRIVATE_KEY = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgfakepasskeyprivatekey+/=";
const made: BrowserPasskey = {
  rpId: "portal.example.test",
  credentialId: "fake-credential-id",
  privateKey: PRIVATE_KEY,
  userHandle: "fake-user-handle",
};

async function passkeyStep(options: {
  kind: "create_passkey" | "use_passkey";
  resolved: Awaited<ReturnType<ResolvePasskey>> | (() => never);
  page: Partial<Awaited<ReturnType<FakeBrowserProvider["act"]>>>;
  actions?: unknown[];
}) {
  const browser = new FakeBrowserProvider();
  const act = vi.spyOn(browser, "act").mockResolvedValue({
    ok: true,
    completed: 1,
    url: `${origin}/settings`,
    title: "Settings",
    ...options.page,
  });
  const resolve = vi.fn(async () =>
    typeof options.resolved === "function" ? options.resolved() : options.resolved,
  );
  const result = await browserActFromTool(
    browser,
    computer,
    context,
    { actions: options.actions ?? [{ kind: options.kind, ref: "e4", secret: "portal" }] },
    { resolvePasskey: resolve, redactions: () => [PRIVATE_KEY] },
  );
  return { act, result, resolve };
}

describe("browser_act passkey steps", () => {
  it("reads a passkey step only with the saved login it is for", () => {
    expect(
      parseBrowserActions([{ kind: "create_passkey", ref: "e4", secret: " portal " }]),
    ).toEqual([{ kind: "create_passkey", ref: "e4", secret: "portal" }]);
    expect(() => parseBrowserActions([{ kind: "use_passkey", ref: "e4" }])).toThrow(/needs secret/);
  });

  it("creates a passkey with no credential on the tab, and only the vault gets it", async () => {
    const created = vi.fn(async () => undefined);
    const typed = vi.fn(async () => undefined);
    const { act, result } = await passkeyStep({
      kind: "create_passkey",
      resolved: { origin, created, typed },
      page: { passkey: made },
    });
    expect(act.mock.calls[0]?.[1].actions).toEqual([{ kind: "passkey", ref: "e4", origin }]);
    expect(created).toHaveBeenCalledWith(made);
    expect(typed).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: true });
    expect(JSON.stringify(result)).not.toContain(PRIVATE_KEY);
    expect(JSON.stringify(result)).not.toContain("passkey");
  });

  it("keeps a passkey the site created even when the step then failed", async () => {
    const created = vi.fn(async () => undefined);
    const { result } = await passkeyStep({
      kind: "create_passkey",
      resolved: { origin, created },
      page: { ok: false, uncertain: true, error: "socket closed", passkey: made },
    });
    expect(created).toHaveBeenCalledWith(made);
    expect(JSON.stringify(result)).not.toContain(PRIVATE_KEY);
  });

  it("says no passkey was saved when the page answered without one", async () => {
    const created = vi.fn(async () => undefined);
    const { result } = await passkeyStep({
      kind: "create_passkey",
      resolved: { origin, created },
      page: {},
    });
    expect(created).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("no passkey") });
  });

  it("tells the bot not to create another when the created passkey could not be saved", async () => {
    const { result } = await passkeyStep({
      kind: "create_passkey",
      resolved: {
        origin,
        created: async () => {
          throw new Error(`database down ${PRIVATE_KEY}`);
        },
      },
      page: { passkey: made },
    });
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("do not create another"),
    });
    expect(JSON.stringify(result)).not.toContain(PRIVATE_KEY);
  });

  it("signs in with the saved passkey on its site and keeps it out of the result", async () => {
    const credential = {
      credentialId: made.credentialId,
      privateKey: PRIVATE_KEY,
      userHandle: "fake-user-handle",
      signCount: 120,
    };
    const { act, result } = await passkeyStep({
      kind: "use_passkey",
      resolved: { origin, rpId: made.rpId, credential },
      // A page that shows the key somehow is still redacted.
      page: { title: `Signed in ${PRIVATE_KEY}` },
    });
    expect(act.mock.calls[0]?.[1].actions).toEqual([
      { kind: "passkey", ref: "e4", origin, rpId: made.rpId, credential },
    ]);
    expect(JSON.stringify(result)).not.toContain(PRIVATE_KEY);
  });

  it("refuses a passkey step with other steps, or one its login refuses, before the page is asked", async () => {
    for (const options of [
      {
        resolved: { origin },
        actions: [
          { kind: "use_passkey", ref: "e4", secret: "portal" },
          { kind: "click", ref: "e5" },
        ],
      },
      { resolved: { error: "This login has no passkey." } },
      {
        resolved: () => {
          throw new Error(`unreadable ${PRIVATE_KEY}`);
        },
      },
    ]) {
      const { act, result } = await passkeyStep({
        kind: "use_passkey",
        page: {},
        ...options,
      });
      expect(act).not.toHaveBeenCalled();
      expect(result).toMatchObject({ ok: false, completed: 0 });
      expect(JSON.stringify(result)).not.toContain(PRIVATE_KEY);
    }
  });

  it("reads a created passkey from the computer's page browser only whole", async () => {
    const live: ComputerRef = { id: "c1", botId: "b1", kind: "docker", providerRef: "c1" };
    for (const [answer, passkey] of [
      [{ ok: true, completed: 1, passkey: made }, made],
      // An answer it can't trust keeps the passkey all the same.
      [{ ok: true, passkey: made }, made],
      [{ ok: false, uncertain: true, error: "gone", passkey: made }, made],
      [{ ok: true, completed: 1, passkey: { ...made, privateKey: "" } }, undefined],
      [{ ok: true, completed: 1, passkey: { rpId: made.rpId } }, undefined],
      [{ ok: true, completed: 1, passkey: "nope" }, undefined],
    ] as const) {
      const browser = new ComputerBrowserProvider({
        liveDriver: async () => ({ url: `${origin}/`, title: "Portal", ...answer }) as never,
      });
      const result = await browser.act(
        live,
        { actions: [{ kind: "passkey", ref: "e4", origin }] },
        context,
      );
      expect(result.passkey).toEqual(passkey);
    }
  });
});
