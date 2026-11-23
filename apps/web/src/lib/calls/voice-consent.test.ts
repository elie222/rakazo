import { AI_DISCLOSURE_VERSION } from "@rakazo/contracts";
import { flush } from "@rakazo/core/test-async";
import { afterEach, expect, it, vi } from "vitest";
import {
  cancelVoiceConsent,
  ensureVoiceConsent,
  invalidateVoiceConsent,
  pendingVoiceConsent,
} from "./voice-consent";

const api = vi.hoisted(() => ({ status: vi.fn(), allow: vi.fn(), client: vi.fn() }));
vi.mock("../query/rpc", () => ({ createSpaceRpc: api.client }));
const recipient = {
  key: "speech-example",
  name: "Example speech server",
  detail: "https://speech.example.test",
  use: "voice" as const,
  allowed: false,
};
afterEach(() => {
  cancelVoiceConsent();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});
function setup() {
  api.client.mockReturnValue({ aiConsent: { status: api.status, allow: api.allow } });
  api.status.mockResolvedValue({
    scope: "account-space",
    version: AI_DISCLOSURE_VERSION,
    recipients: [recipient],
  });
  api.allow.mockResolvedValue({});
}
it("records the reviewed recipient on the captured Space and settings copy before continuing", async () => {
  setup();
  const first = ensureVoiceConsent("space-a", "account");
  const second = ensureVoiceConsent("space-a", "account");
  await flush();
  expect(api.allow).not.toHaveBeenCalled();
  expect(pendingVoiceConsent()?.recipient).toEqual(recipient);
  pendingVoiceConsent()!.finish(true);
  await Promise.all([first, second]);
  expect(api.client).toHaveBeenCalledWith("space-a");
  expect(api.status).toHaveBeenCalledWith(
    { uses: ["voice"], settingsScope: "account" },
    { signal: undefined },
  );
  expect(api.allow).toHaveBeenCalledTimes(1);
  expect(api.allow).toHaveBeenCalledWith({
    scope: "account-space",
    version: AI_DISCLOSURE_VERSION,
    keys: [recipient.key],
    settingsScope: "account",
  });
  expect(pendingVoiceConsent()).toBeNull();
});
it("cancels queued disclosures without recording a grant", async () => {
  setup();
  const first = ensureVoiceConsent("space-a");
  const second = ensureVoiceConsent("space-b");
  const rejected = Promise.all([
    expect(first).rejects.toThrow("not allowed"),
    expect(second).rejects.toThrow("not allowed"),
  ]);
  await flush();
  cancelVoiceConsent();
  await rejected;
  expect(api.allow).not.toHaveBeenCalled();
  expect(pendingVoiceConsent()).toBeNull();
});
it("propagates a failed consent save and requires another review before retrying", async () => {
  setup();
  api.allow.mockRejectedValueOnce(new Error("save failed"));
  const first = ensureVoiceConsent("space-a");
  const rejected = expect(first).rejects.toThrow("save failed");
  await flush();
  pendingVoiceConsent()!.finish(true);
  await rejected;
  const retry = ensureVoiceConsent("space-a");
  await flush();
  expect(pendingVoiceConsent()).not.toBeNull();
  pendingVoiceConsent()!.finish(true);
  await retry;
});

it("dismisses an aborted speech request's disclosure without a grant", async () => {
  setup();
  const controller = new AbortController();
  const checking = ensureVoiceConsent("space-a", undefined, controller.signal);
  const rejected = expect(checking).rejects.toThrow();
  await flush();
  expect(pendingVoiceConsent()).not.toBeNull();
  controller.abort();
  await rejected;
  expect(pendingVoiceConsent()).toBeNull();
  expect(api.allow).not.toHaveBeenCalled();
});

it("does not let one aborted request reject another request's disclosure", async () => {
  setup();
  const first = new AbortController();
  const second = new AbortController();
  const stopped = ensureVoiceConsent("space-a", undefined, first.signal);
  const rejected = expect(stopped).rejects.toThrow();
  const continuing = ensureVoiceConsent("space-a", undefined, second.signal);
  await flush();
  first.abort();
  await rejected;
  expect(pendingVoiceConsent()).not.toBeNull();
  pendingVoiceConsent()!.finish(true);
  await continuing;
  expect(api.allow).toHaveBeenCalledTimes(1);
});
it("reuses successful consent briefly per Space and copy, and clears it on invalidation", async () => {
  setup();
  let now = 100000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  api.status.mockResolvedValue({
    scope: "account-space",
    version: AI_DISCLOSURE_VERSION,
    recipients: [{ ...recipient, allowed: true }],
  });
  await ensureVoiceConsent("space-a");
  await ensureVoiceConsent("space-a");
  expect(api.status).toHaveBeenCalledTimes(1);
  await ensureVoiceConsent("space-b");
  await ensureVoiceConsent("space-a", "account");
  expect(api.status).toHaveBeenCalledTimes(3);
  now += 30001;
  await ensureVoiceConsent("space-a");
  expect(api.status).toHaveBeenCalledTimes(4);
  invalidateVoiceConsent();
  await ensureVoiceConsent("space-a");
  expect(api.status).toHaveBeenCalledTimes(5);
});
