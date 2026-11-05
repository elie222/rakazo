import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyMemmyConnectionSettings,
  memmyRequiresPrivateEndpoint,
} from "./memmy-connection-trust.js";
import type { MemmySearchInput, MemmySourceTurnBody } from "./memmy-memory-client.js";
import { MemmyMemoryClient, resetMemmyCircuitBreakers } from "./memmy-memory-client.js";
import type { ResolvedAddress } from "./network-address.js";

// Replace only the audit sink; the classifier, client and outbound address guards stay real.
vi.mock("@rakazo/db", () => ({ recordSecurityEvent: vi.fn(async () => undefined) }));

const baseUrl = "https://memory.example.com";
const publicIp = "203.0.113.10";
const privateIp = "10.99.17.23";
const loopbackIp = "127.22.33.44";
const ipv4LinkLocal = "169.254.33.44";
const ipv6LinkLocal = "fe80::7";

function addresses(ips: readonly string[]): ResolvedAddress[] {
  return ips.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
}

const answerCases: Array<{
  label: string;
  ips: string[];
  classification: "private" | "blocked" | "empty";
}> = [
  { label: "RFC1918", ips: [privateIp], classification: "private" },
  { label: "IPv4 loopback", ips: [loopbackIp], classification: "private" },
  { label: "IPv4 link-local", ips: [ipv4LinkLocal], classification: "blocked" },
  { label: "IPv6 link-local", ips: [ipv6LinkLocal], classification: "blocked" },
  { label: "no addresses", ips: [], classification: "empty" },
  { label: "public then private", ips: [publicIp, privateIp], classification: "private" },
  { label: "private then public", ips: [privateIp, publicIp], classification: "private" },
  {
    label: "public then IPv6 link-local",
    ips: [publicIp, ipv6LinkLocal],
    classification: "blocked",
  },
  {
    label: "IPv6 link-local then public",
    ips: [ipv6LinkLocal, publicIp],
    classification: "blocked",
  },
  {
    label: "private then IPv4 link-local",
    ips: [privateIp, ipv4LinkLocal],
    classification: "blocked",
  },
  {
    label: "IPv4 link-local then private",
    ips: [ipv4LinkLocal, privateIp],
    classification: "blocked",
  },
];

const searchInput: MemmySearchInput = {
  query: "synthetic transport probe",
  layers: ["episode"],
  limit: 1,
  contextBudget: 100,
  namespaces: [{ source: "rakazo", userId: "test-owner" }],
};

const captureBody: MemmySourceTurnBody = {
  requestId: "test-request",
  channel: "hook",
  source: "rakazo",
  namespace: { userId: "test-owner" },
  sourceTurn: {
    source: "rakazo",
    profileId: "test-profile",
    conversationId: "test-conversation",
    turnId: "test-turn",
    startedAt: "2026-11-05T00:00:00.000Z",
    completedAt: "2026-11-05T00:00:01.000Z",
    completionEvidence: "run.completed",
  },
  query: "synthetic question",
  answer: "synthetic answer",
  status: "succeeded",
  toolCalls: [],
  toolResults: [],
  sourceMemoryIds: [],
};

beforeEach(() => {
  resetMemmyCircuitBreakers();
  // DNS and HTTP use their external I/O seams; a missed seam must never open a real socket.
  vi.spyOn(Socket.prototype, "connect").mockImplementation(() => {
    throw new Error("Unexpected network connection in an offline transport test");
  });
});

afterEach(() => {
  try {
    expect(Socket.prototype.connect).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});

describe("R5: public-looking Memmy endpoint classification", () => {
  it.each(answerCases)("classifies $label DNS answers", async ({ ips, classification }) => {
    const resolve = vi.fn(async () => addresses(ips));
    expect(memmyRequiresPrivateEndpoint({ baseUrl })).toBe(false);

    const pending = classifyMemmyConnectionSettings({ baseUrl }, resolve);
    if (classification === "private") {
      const settings = await pending;
      expect(settings).toEqual({ baseUrl, endpointTrust: "private" });
      expect(memmyRequiresPrivateEndpoint(settings)).toBe(true);
    } else {
      await expect(pending).rejects.toThrow(
        classification === "empty"
          ? "Memory base URL did not resolve to an address."
          : "Memory base URL targets a blocked address.",
      );
    }
    expect(resolve).toHaveBeenCalledExactlyOnceWith("memory.example.com");
  });

  it.each(["?", "#"])(
    "rejects a bare %s delimiter before resolving the hostname",
    async (suffix) => {
      const resolve = vi.fn(async () => addresses([publicIp]));

      await expect(
        classifyMemmyConnectionSettings({ baseUrl: `${baseUrl}${suffix}` }, resolve),
      ).rejects.toThrow(
        "Memory base URL must use HTTP(S) without credentials, a query, or a fragment.",
      );
      expect(resolve).not.toHaveBeenCalled();
    },
  );
});

describe("R5: classified endpoint through the real Memmy client transport", () => {
  it.each(answerCases)(
    "blocks a public endpoint rebound to $label before any HTTP fetch",
    async ({ ips }) => {
      const resolve = vi
        .fn(async () => addresses(ips))
        .mockResolvedValueOnce(addresses([publicIp]));
      const settings = await classifyMemmyConnectionSettings({ baseUrl }, resolve);
      expect(settings).toEqual({ baseUrl });
      expect(memmyRequiresPrivateEndpoint(settings)).toBe(false);

      const fetchImpl = vi.fn(async () =>
        Response.json({ status: "stored", debug: { sections: [] } }),
      );
      const client = new MemmyMemoryClient({
        baseUrl: settings.baseUrl!,
        token: "synthetic-unit-test-token",
        endpointTrust: memmyRequiresPrivateEndpoint(settings) ? "private" : "public",
        resolveHostname: resolve,
        fetch: fetchImpl,
      });

      await expect(client.search(searchInput)).resolves.toEqual({
        ok: false,
        error: "network_error",
      });
      await expect(client.complete(captureBody)).resolves.toEqual({
        status: "retryable",
        reason: "network_error",
      });
      await expect(
        client.add({
          requestId: "test-add",
          content: "synthetic durable fact",
          layer: "L2",
          tags: [],
          namespace: { userId: "test-owner" },
        }),
      ).resolves.toEqual({ ok: false, error: "Memmy save failed: network_error" });

      expect(resolve.mock.calls).toEqual(Array.from({ length: 4 }, () => ["memory.example.com"]));
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("allows a still-public URL prefix and appends each route without changing the host", async () => {
    const resolve = vi.fn(async () => addresses([publicIp, "203.0.113.11"]));
    const settings = await classifyMemmyConnectionSettings(
      { baseUrl: `${baseUrl}/memory/` },
      resolve,
    );
    expect(settings).toEqual({ baseUrl: `${baseUrl}/memory` });
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ status: "stored", debug: { sections: [] } }),
    );
    const client = new MemmyMemoryClient({
      baseUrl: settings.baseUrl!,
      token: "synthetic-unit-test-token",
      endpointTrust: memmyRequiresPrivateEndpoint(settings) ? "private" : "public",
      resolveHostname: resolve,
      fetch: fetchImpl,
    });

    await expect(client.search(searchInput)).resolves.toEqual({
      ok: true,
      value: { sections: [], sourceMemoryIds: [] },
    });
    await expect(client.complete(captureBody)).resolves.toEqual({ status: "stored" });
    await expect(
      client.add({
        requestId: "test-add",
        content: "synthetic durable fact",
        layer: "L2",
        tags: [],
        namespace: { userId: "test-owner" },
      }),
    ).resolves.toEqual({ ok: true, value: undefined });

    expect(resolve.mock.calls).toEqual(Array.from({ length: 4 }, () => ["memory.example.com"]));
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      `${baseUrl}/memory/api/v1/memory/search`,
      `${baseUrl}/memory/api/v1/source-turns/complete`,
      `${baseUrl}/memory/api/v1/memory/add`,
    ]);
  });
});
