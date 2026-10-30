// @vitest-environment jsdom
import { ORPCError } from "@orpc/client";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ runtimeProfileGet: vi.fn(), runtimeProfileUpdate: vi.fn() }));
vi.mock("../lib/rpc", () => ({ rpc: { bots: api } }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));

import { BotPersonaSettings } from "./BotPersonaSettings";

const profile = {
  botId: "fixture",
  revision: 3,
  activationStatus: "partial" as const,
  supportedCapabilities: ["persona"],
  settings: {
    schemaVersion: 1 as const,
    persona: { persona: "" },
    skills: { mode: "legacy-library" as const },
    extensions: [],
    learning: { mode: "off" as const, maxReviewsPerDay: 0, maxCandidatesPerReview: 0, maxTokensPerReview: 0, maxReviewSeconds: 0, maxRetries: 0 },
    initiative: { enabled: false, maxRunsPerDay: 0, maxTokensPerRun: 0, maxRunSeconds: 0, maxRetries: 0, maxConcurrentRuns: 0, maxMessagesPerDay: 0 },
    routing: { enabled: false, routes: [] },
  },
};

it("loads persona and saves it with the current revision", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.runtimeProfileGet.mockResolvedValue(profile);
  api.runtimeProfileUpdate.mockImplementation(async (input) => ({
    ...profile,
    revision: 4,
    settings: input.settings,
  }));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<BotPersonaSettings botId="fixture" />));
    expect(host.textContent).toContain("Saved revision 3");
    expect(host.textContent).toContain("not active here");
    const field = host.querySelector("textarea")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(field, "Warm, concise voice");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => host.querySelector("button")!.click());
    expect(api.runtimeProfileUpdate).toHaveBeenCalledWith({
      botId: "fixture",
      expectedRevision: 3,
      reason: "Update persona",
      settings: { ...profile.settings, persona: { persona: "Warm, concise voice" } },
    });
    expect(host.textContent).toContain("Saved revision 4");
    expect(host.textContent).toContain("Persona saved");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  }
});

it("blocks an outdated save and offers reload after a revision conflict", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.runtimeProfileGet.mockResolvedValue(profile);
  api.runtimeProfileUpdate.mockRejectedValue(new ORPCError("CONFLICT"));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<BotPersonaSettings botId="fixture" />));
    const field = host.querySelector("textarea")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(field, "Changed locally");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => host.querySelector("button")!.click());
    expect(host.textContent).toContain("Reload");
    expect(field.disabled).toBe(true);
    api.runtimeProfileGet.mockResolvedValue({
      ...profile,
      revision: 4,
      settings: { ...profile.settings, persona: { persona: "Changed elsewhere" } },
    });
    await act(async () =>
      [...host.querySelectorAll("button")].find((button) => button.textContent === "Reload")!.click(),
    );
    expect(field.value).toBe("Changed elsewhere");
    expect(host.textContent).toContain("Saved revision 4");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  }
});
