// @vitest-environment jsdom

import { deferred, flush } from "@rakazo/core/test-async";
import type * as UiWeb from "@rakazo/ui-web";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

const voice = vi.hoisted(() => ({
  catalog: vi.fn(),
  credentials: vi.fn(),
  status: vi.fn(),
  voices: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  setVoice: vi.fn(),
  setSpeechModel: vi.fn(),
}));

const models = vi.hoisted(() => ({
  beginOAuth: vi.fn(),
  completeOAuth: vi.fn(),
  finishOAuth: vi.fn(),
  cancelOAuth: vi.fn(),
  submitOAuthCode: vi.fn(),
  // Read keys for the Models data a sign-in here makes stale.
  credentials: vi.fn(),
  list: vi.fn(),
}));

const { speak, activeCall } = vi.hoisted(() => ({
  speak: vi.fn(async () => undefined),
  activeCall: { current: null as { phase: string } | null },
}));
vi.mock("../../lib/calls/tts.js", () => ({ speaker: { speak, state: {} } }));
vi.mock("../../lib/calls/call-session", () => ({ useCallSession: () => activeCall.current }));
vi.mock("../../lib/query/rpc", () => ({
  rpc: { voice, models },
  rpcForSpace: () => ({ voice, models }),
  createSpaceRpc: () => ({ voice, models }),
  selectedSpaceId: () => null,
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + String(values[index - 1]) + part);
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children: ReactNode }) => children,
    Plural: ({ one, other, value }: { one: string; other: string; value: number }) =>
      (value === 1 ? one : other).replace("#", String(value)),
  };
});
vi.mock("@rakazo/ui-web", async (importOriginal) => {
  const { buttonVariants, Disclosure, OptionSelect, Stepper, SwitchField, useCopyText } =
    await importOriginal<typeof UiWeb>();
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Spinner: (props: ComponentProps<"svg">) => <svg role="status" {...props} />,
    Button: ({
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
    Dialog: Container,
    DialogClose: Container,
    DialogContent: Container,
    DialogTitle: Container,
    buttonVariants,
    Disclosure,
    Field: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    FieldLabel: ({ children, htmlFor }: { children?: ReactNode; htmlFor?: string }) => (
      <label htmlFor={htmlFor}>{children}</label>
    ),
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    OptionSelect,
    Stepper,
    SwitchField,
    useCopyText,
  };
});

import { VoiceSettingsOverlay } from "./VoiceSettingsOverlay";

function withQueries(ui: ReactNode, client = new QueryClient()) {
  client.setDefaultOptions({ queries: { retry: false } });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

const fish = {
  id: "cred-fish",
  provider: "fish-audio",
  hasKey: true,
  isDefault: true,
  voiceId: "voice-1",
  speechModel: "",
  transcribe: true,
};

function labelledInput(container: HTMLElement, text: string): HTMLInputElement {
  const found = [...container.querySelectorAll("input")].find(
    (input) => container.querySelector(`label[for="${input.id}"]`)?.textContent === text,
  );
  if (!found) throw new Error(`Missing field: ${text}`);
  return found;
}

describe("a provider the account's model connection can authenticate", () => {
  const xai = { id: "xai", name: "xAI", description: "", transcribe: true };
  const linkedCredential = { ...fish, provider: "xai", voiceId: "eve", hasKey: false };
  const type = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const button = (container: HTMLElement, text: string) =>
    [...container.querySelectorAll("button")].find((entry) => entry.textContent === text);
  const click = async (target: HTMLElement | undefined) => {
    if (!target) throw new Error("Missing button");
    await act(async () => target.click());
  };

  async function open(catalogEntry: object, credentials: object[] = []) {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    voice.catalog.mockReset().mockResolvedValue([catalogEntry]);
    voice.credentials.mockReset().mockResolvedValue(credentials);
    voice.status.mockReset().mockResolvedValue({
      configured: credentials.length > 0,
      ready: credentials.length > 0,
      transcribe: false,
      provider: credentials.length ? "xai" : null,
      voiceId: "",
    });
    voice.voices.mockReset().mockResolvedValue([{ id: "eve", label: "Eve" }]);
    voice.connect.mockReset().mockResolvedValue(linkedCredential);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        withQueries(<VoiceSettingsOverlay embedded scope="account" onClose={() => undefined} />),
      );
    });
    await act(async () => {
      await flush();
    });
    return {
      container,
      async close() {
        await act(async () => root.unmount());
        container.remove();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
      },
    };
  }

  it("connects through the account's model connection it names", async () => {
    const { container, close } = await open({
      ...xai,
      modelConnections: [{ id: "cred-model-1", label: "SuperGrok" }],
    });
    try {
      // The server lists the linked connection from now on.
      voice.credentials.mockResolvedValue([linkedCredential]);
      await click(button(container, "Use SuperGrok"));
      expect(voice.connect).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          scope: "account",
          provider: "xai",
          apiKey: "",
          modelCredentialId: "cred-model-1",
        }),
      );
      await vi.waitFor(() => expect(container.textContent).toContain("Connected xAI."));
      // Linked: the connection is all there is; no key to show or replace.
      expect(button(container, "Use SuperGrok")).toBeUndefined();
      expect(button(container, "Disconnect")).toBeTruthy();
    } finally {
      await close();
    }
  });

  it("connects through whichever of several model connections is chosen", async () => {
    const { container, close } = await open({
      ...xai,
      modelConnections: [
        { id: "cred-model-1", label: "SuperGrok" },
        { id: "cred-model-2", label: "Work xAI" },
      ],
    });
    try {
      expect(button(container, "Use SuperGrok")).toBeTruthy();
      await click(button(container, "Use Work xAI"));
      expect(voice.connect).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ apiKey: "", modelCredentialId: "cred-model-2" }),
      );
    } finally {
      await close();
    }
  });

  it("signs in through Models and connects voice to the saved connection", async () => {
    const { container, close } = await open({
      ...xai,
      modelSignIn: "Sign in with Subscription",
    });
    const completion = deferred<{ status: "ready" }>();
    models.beginOAuth.mockReset().mockResolvedValue({
      mode: "device-code",
      loginId: "login-1",
      verificationUri: "https://example.test/device",
      userCode: "ABCD-1234",
      expiresInSeconds: 300,
    });
    models.completeOAuth.mockReset().mockReturnValue(completion.promise);
    models.finishOAuth.mockReset().mockResolvedValue({ id: "cred-model-new" });
    models.cancelOAuth.mockReset().mockResolvedValue(undefined);
    try {
      await click(button(container, "Sign in with Subscription"));
      expect(models.beginOAuth).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ provider: "xai", credentialId: null, makeDefault: false }),
        expect.anything(),
      );
      // The same panel Models shows waits for the sign-in.
      expect(container.textContent).toContain("ABCD-1234");
      expect(voice.connect).not.toHaveBeenCalled();
      // After the sign-in, Models lists the new connection and voice is linked to it.
      const signedIn = { ...linkedCredential, modelCredentialId: "cred-model-new" };
      voice.connect.mockResolvedValue(signedIn);
      voice.credentials.mockResolvedValue([signedIn]);
      voice.catalog.mockResolvedValue([
        { ...xai, modelConnections: [{ id: "cred-model-new", label: "xAI" }] },
      ]);
      await act(async () => completion.resolve({ status: "ready" }));
      await vi.waitFor(() =>
        expect(voice.connect).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            provider: "xai",
            apiKey: "",
            modelCredentialId: "cred-model-new",
          }),
        ),
      );
      expect(models.finishOAuth).toHaveBeenCalledExactlyOnceWith(
        { loginId: "login-1" },
        expect.anything(),
      );
      await vi.waitFor(() => expect(container.textContent).toContain("Connected xAI."));
      expect(button(container, "Sign in with Subscription")).toBeUndefined();
      expect(button(container, "Disconnect")).toBeTruthy();
    } finally {
      await close();
    }
  });

  it("offers the new connection, not another sign-in, when voice cannot use it", async () => {
    const { container, close } = await open({
      ...xai,
      modelSignIn: "Sign in with Subscription",
    });
    models.beginOAuth.mockReset().mockResolvedValue({
      mode: "device-code",
      loginId: "login-1",
      verificationUri: "https://example.test/device",
      userCode: "ABCD-1234",
      expiresInSeconds: 300,
    });
    models.completeOAuth.mockReset().mockResolvedValue({ status: "ready" });
    models.finishOAuth.mockReset().mockResolvedValue({ id: "cred-model-new" });
    models.cancelOAuth.mockReset().mockResolvedValue(undefined);
    voice.connect.mockReset().mockRejectedValue(new Error("xAI is unavailable right now."));
    // The sign-in saved a Models connection, which the next catalog read lists.
    voice.catalog.mockResolvedValue([
      { ...xai, modelConnections: [{ id: "cred-model-new", label: "me@example.test" }] },
    ]);
    try {
      await click(button(container, "Sign in with Subscription"));
      await vi.waitFor(() => expect(button(container, "Use me@example.test")).toBeTruthy());
      expect(container.textContent).toContain("xAI is unavailable right now.");
      expect(button(container, "Sign in with Subscription")).toBeUndefined();
      expect(models.beginOAuth).toHaveBeenCalledOnce();
    } finally {
      await close();
    }
  });

  it("shows a failed sign-in in the form", async () => {
    const { container, close } = await open({
      ...xai,
      modelSignIn: "Sign in with Subscription",
    });
    models.beginOAuth.mockReset().mockRejectedValue(new Error("Sign-in is unavailable."));
    try {
      await click(button(container, "Sign in with Subscription"));
      await vi.waitFor(() => expect(container.textContent).toContain("Sign-in is unavailable."));
      expect(voice.connect).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it("folds the key form behind Or paste an API key and still connects a typed key", async () => {
    const { container, close } = await open({
      ...xai,
      modelSignIn: "Sign in with Subscription",
    });
    try {
      expect(() => labelledInput(container, "API key")).toThrow();
      expect(button(container, "Connect")).toBeUndefined();
      await click(
        [...container.querySelectorAll("button")].find((entry) =>
          entry.textContent?.startsWith("Or paste an API key"),
        ),
      );
      const key = labelledInput(container, "API key");
      expect(key.placeholder).toBe("Paste your API key");
      expect(document.activeElement).toBe(key);
      expect(button(container, "Connect")?.disabled).toBe(true);
      await type(key, "  xai-key-123  ");
      await click(button(container, "Connect"));
      expect(voice.connect).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ provider: "xai", apiKey: "xai-key-123" }),
      );
      expect(voice.connect.mock.calls[0]?.[0]).not.toHaveProperty("modelCredentialId");
    } finally {
      await close();
    }
  });

  it("shows the key form as before when there is no model connection to offer", async () => {
    const { container, close } = await open(xai);
    try {
      expect(labelledInput(container, "API key").placeholder).toBe("Paste your API key");
      expect(button(container, "Connect")?.disabled).toBe(true);
      expect(container.textContent).not.toContain("Or paste an API key");
    } finally {
      await close();
    }
  });

  it("links voice again once the model connection it used is gone", async () => {
    const { container, close } = await open(
      { ...xai, modelConnections: [{ id: "cred-model-2", label: "SuperGrok" }] },
      [{ ...linkedCredential, modelCredentialId: "cred-gone" }],
    );
    try {
      await click(button(container, "Use SuperGrok"));
      expect(voice.connect).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ provider: "xai", apiKey: "", modelCredentialId: "cred-model-2" }),
      );
      expect(button(container, "Disconnect")).toBeTruthy();
    } finally {
      await close();
    }
  });

  it("moves a working link to another of the account's subscriptions", async () => {
    const { container, close } = await open(
      {
        ...xai,
        modelConnections: [
          { id: "cred-model-1", label: "xAI" },
          { id: "cred-model-2", label: "xAI 2" },
        ],
      },
      [{ ...linkedCredential, modelCredentialId: "cred-model-1" }],
    );
    try {
      expect(button(container, "Use xAI")).toBeUndefined();
      expect(button(container, "Or paste an API key")).toBeUndefined();
      await click(button(container, "Use xAI 2"));
      expect(voice.connect).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ provider: "xai", apiKey: "", modelCredentialId: "cred-model-2" }),
      );
    } finally {
      await close();
    }
  });

  it("keeps Disconnect off while a sign-in to link voice again is open", async () => {
    const { container, close } = await open({ ...xai, modelSignIn: "Sign in with Subscription" }, [
      { ...linkedCredential, modelCredentialId: "cred-gone" },
    ]);
    models.beginOAuth.mockReset().mockResolvedValue({
      mode: "device-code",
      loginId: "login-1",
      verificationUri: "https://example.test/device",
      userCode: "ABCD-1234",
      expiresInSeconds: 300,
    });
    models.completeOAuth.mockReset().mockReturnValue(deferred<{ status: "ready" }>().promise);
    models.cancelOAuth.mockReset().mockResolvedValue(undefined);
    try {
      expect(button(container, "Disconnect")?.disabled).toBe(false);
      await click(button(container, "Sign in with Subscription"));
      expect(container.textContent).toContain("ABCD-1234");
      expect(button(container, "Disconnect")?.disabled).toBe(true);
    } finally {
      await close();
    }
  });

  it("offers only Disconnect once linked to the model connection", async () => {
    const { container, close } = await open(
      { ...xai, modelConnections: [{ id: "cred-model-1", label: "SuperGrok" }] },
      [linkedCredential],
    );
    try {
      expect(container.textContent).not.toContain("API key");
      expect(button(container, "Use SuperGrok")).toBeUndefined();
      expect(button(container, "Replace key")).toBeUndefined();
      expect(button(container, "Connect")).toBeUndefined();
      expect(button(container, "Disconnect")).toBeTruthy();
    } finally {
      await close();
    }
  });
});
