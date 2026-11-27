import { describe, expect, it } from "vitest";
import { voiceConnectionForm } from "./voice-connection-ui.js";

const entry = {
  id: "xai",
  modelConnections: [{ id: "model-1", label: "xAI" }],
  modelSignIn: "Sign in",
};
const form = (
  credential: { hasKey: boolean; modelCredentialId?: string } | undefined,
  overrides: Partial<typeof entry> = {},
) =>
  voiceConnectionForm({ entry: { ...entry, ...overrides }, credential, apiKey: "", baseUrl: "" });

describe("voiceConnectionForm", () => {
  it("offers the account's connections before voice connects, and nothing once linked", () => {
    expect(form(undefined)).toMatchObject({
      linked: false,
      modelConnections: entry.modelConnections,
      modelSignIn: undefined,
    });
    expect(form({ hasKey: false, modelCredentialId: "model-1" })).toEqual({
      linked: true,
      canConnect: false,
      modelConnections: [],
      modelSignIn: undefined,
    });
    // A link that names no connection uses whichever the provider has.
    expect(form({ hasKey: false })).toMatchObject({ linked: true, modelConnections: [] });
  });

  it("lets a key-based voice connection move to a Models connection", () => {
    expect(form({ hasKey: true })).toMatchObject({
      linked: false,
      modelConnections: entry.modelConnections,
      modelSignIn: undefined,
    });
  });

  it("lets a working link move to another of the account's connections", () => {
    const two = [
      { id: "model-1", label: "xAI" },
      { id: "model-2", label: "xAI 2" },
    ];
    expect(
      form({ hasKey: false, modelCredentialId: "model-1" }, { modelConnections: two }),
    ).toEqual({
      linked: true,
      canConnect: false,
      modelConnections: [two[1]],
      modelSignIn: undefined,
    });
    // A link that names no connection may be on either, so both are offered.
    expect(form({ hasKey: false }, { modelConnections: two })).toMatchObject({
      linked: true,
      modelConnections: two,
    });
  });

  it("offers the choices again once the model connection a link uses is gone", () => {
    const replacement = [{ id: "model-2", label: "xAI 2" }];
    expect(
      form({ hasKey: false, modelCredentialId: "model-1" }, { modelConnections: replacement }),
    ).toMatchObject({ linked: false, modelConnections: replacement, modelSignIn: undefined });
    for (const credential of [{ hasKey: false, modelCredentialId: "model-1" }, { hasKey: false }]) {
      expect(form(credential, { modelConnections: [] })).toMatchObject({
        linked: false,
        modelConnections: [],
        modelSignIn: "Sign in",
      });
    }
  });
});
