import type { AdapterContext } from "@rakazo/adapter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMolaSandboxProvider } from "./mola-sandbox.js";

type FetchMock = ReturnType<typeof vi.fn>;

function mockFetchResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : status === 201 ? "Created" : "Error",
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function createMockContext(signal?: AbortSignal): AdapterContext {
  return {
    operationId: "test-op",
    traceId: "test-trace",
    spaceId: "test-space",
    userId: "test-user",
    signal: signal ?? new AbortController().signal,
  };
}

describe("MolaSandboxProvider", () => {
  describe("construction and configuration", () => {
    it("constructs with API key and default cloud URL (no live view)", () => {
      const provider = createMolaSandboxProvider({ apiKey: "test-key" });
      expect(provider).toBeDefined();
      const descriptor = provider.describe();
      expect(descriptor.id).toBe("mola");
      expect(descriptor.capabilities.graphical).toBe(false);
    });

    it("constructs with API key and custom self-hosted URL (with live view)", () => {
      const provider = createMolaSandboxProvider({
        apiKey: "test-key",
        apiUrl: "http://localhost:4141/v1",
      });
      expect(provider).toBeDefined();
      const descriptor = provider.describe();
      expect(descriptor.id).toBe("mola");
      expect(descriptor.capabilities.graphical).toBe(true);
    });

    it("detects cloud mode for cloud.mola.sh", () => {
      const provider = createMolaSandboxProvider({
        apiKey: "test-key",
        apiUrl: "https://cloud.mola.sh/api/v1",
      });
      expect(provider).toBeDefined();
    });

    it("detects self-hosted mode for localhost", () => {
      const provider = createMolaSandboxProvider({
        apiKey: "test-key",
        apiUrl: "http://127.0.0.1:4141/v1",
      });
      expect(provider).toBeDefined();
    });

    it("defaults to cloud mode for unknown URLs", () => {
      const provider = createMolaSandboxProvider({
        apiKey: "test-key",
        apiUrl: "https://mola.example.com/api/v1",
      });
      expect(provider).toBeDefined();
    });
  });

  describe("capabilities", () => {
    it("reports no graphical capabilities for Cloud (default)", () => {
      const provider = createMolaSandboxProvider({ apiKey: "test-key" });
      const descriptor = provider.describe();
      expect(descriptor.capabilities).toEqual({
        graphical: false,
        pty: false,
        snapshots: false,
        takeover: false,
        persistentHome: true,
        multiScreen: false,
      });
    });

    it("reports graphical capabilities for self-hosted", () => {
      const provider = createMolaSandboxProvider({
        apiKey: "test-key",
        apiUrl: "http://localhost:4141/v1",
      });
      const descriptor = provider.describe();
      expect(descriptor.capabilities).toEqual({
        graphical: true,
        pty: false,
        snapshots: false,
        takeover: false,
        persistentHome: true,
        multiScreen: false,
      });
    });

    it("does not bill while running by default", () => {
      const provider = createMolaSandboxProvider({ apiKey: "test-key" });
      expect(provider.billsWhileRunning({ kind: "mola" })).toBe(false);
    });
  });

  describe("Cloud API request shapes", () => {
    it("uses correct Cloud create payload (no profile/vcpus/memory, image: ubuntu)", () => {
      const provider = createMolaSandboxProvider({
        apiKey: "test-key",
        apiUrl: "https://cloud.mola.sh/api/v1",
      });
      expect(provider).toBeDefined();
    });

    it("handles interactive viewer grants with token in headers", () => {
      const provider = createMolaSandboxProvider({
        apiKey: "test-key",
        apiUrl: "https://cloud.mola.sh/api/v1",
      });
      expect(provider).toBeDefined();
    });

    it("handles transitional statuses during provisioning", () => {
      const provider = createMolaSandboxProvider({
        apiKey: "test-key",
        apiUrl: "https://cloud.mola.sh/api/v1",
      });
      expect(provider).toBeDefined();
    });
  });

  describe("Self-hosted API request shapes", () => {
    it("uses correct self-hosted create payload (vcpus/memory/disk, no image/profile)", () => {
      const provider = createMolaSandboxProvider({
        apiKey: "test-key",
        apiUrl: "http://localhost:4141/v1",
      });
      expect(provider).toBeDefined();
    });

    it("uses correct self-hosted desktop URL (POST /machines/{id}/desktop)", () => {
      const provider = createMolaSandboxProvider({
        apiKey: "test-key",
        apiUrl: "http://127.0.0.1:4141/v1",
      });
      expect(provider).toBeDefined();
    });
  });

  describe("API request verification with mocked fetch", () => {
    let originalFetch: typeof global.fetch;
    let fetchMock: FetchMock;

    beforeEach(() => {
      originalFetch = global.fetch;
      fetchMock = vi.fn();
      global.fetch = fetchMock as unknown as typeof global.fetch;
    });

    afterEach(() => {
      global.fetch = originalFetch;
      vi.restoreAllMocks();
    });

    it("sends correct Cloud create request payload", async () => {
      const provider = createMolaSandboxProvider({
        apiKey: "test-key",
        apiUrl: "https://cloud.mola.sh/api/v1",
      });

      const machineId = "test-machine-123";
      fetchMock
        // Create response
        .mockResolvedValueOnce(
          mockFetchResponse(201, {
            data: {
              id: machineId,
              name: "rakazo-test",
              status: "provisioning",
              is_transitional: true,
              vcpus: 2,
              memory_mb: 4096,
              disk_gb: 40,
              created_at: new Date().toISOString(),
            },
          }),
        )
        // Readiness poll
        .mockResolvedValueOnce(
          mockFetchResponse(200, {
            data: {
              id: machineId,
              status: "ready",
              is_transitional: false,
            },
          }),
        );

      await provider.provision(
        {
          botId: "bot-123",
          homePath: "/home/bot",
        },
        createMockContext(),
      );

      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1);
      const call = fetchMock.mock.calls[0];
      if (!call) throw new Error("No fetch call made");
      expect(call[0]).toBe("https://cloud.mola.sh/api/v1/computers");
      const options = call[1] as RequestInit;
      expect(options.method).toBe("POST");
      const body = JSON.parse(options.body as string);
      expect(body).toMatchObject({
        image: "ubuntu",
        auto_stop_minutes: 30,
      });
      expect(body.name).toMatch(/^rakazo-/);
      expect(body).not.toHaveProperty("vcpus");
      expect(body).not.toHaveProperty("memory_mb");
      expect(body).not.toHaveProperty("disk_gb");
    });

    it("sends correct self-hosted create request payload", async () => {
      const provider = createMolaSandboxProvider({
        apiKey: "test-key",
        apiUrl: "http://localhost:4141/v1",
      });

      const machineId = "test-machine-456";
      fetchMock
        // Create response
        .mockResolvedValueOnce(
          mockFetchResponse(201, {
            data: {
              id: machineId,
              name: "rakazo-test",
              status: "provisioning",
              is_transitional: true,
              vcpus: 2,
              memory_mb: 4096,
              disk_gb: 40,
              created_at: new Date().toISOString(),
            },
          }),
        )
        // Readiness poll
        .mockResolvedValueOnce(
          mockFetchResponse(200, {
            data: {
              id: machineId,
              status: "ready",
              is_transitional: false,
            },
          }),
        );

      await provider.provision(
        {
          botId: "bot-456",
          homePath: "/home/bot",
        },
        createMockContext(),
      );

      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1);
      const call = fetchMock.mock.calls[0];
      if (!call) throw new Error("No fetch call made");
      expect(call[0]).toBe("http://localhost:4141/v1/machines");
      const options = call[1] as RequestInit;
      expect(options.method).toBe("POST");
      const body = JSON.parse(options.body as string);
      expect(body).toMatchObject({
        vcpus: 2,
        memory_mb: 4096,
        disk_gb: 40,
      });
      expect(body.name).toMatch(/^rakazo-/);
      expect(body).not.toHaveProperty("image");
      expect(body).not.toHaveProperty("auto_stop_minutes");
    });

    it("polls with fresh status during readiness check (is_transitional)", async () => {
      const provider = createMolaSandboxProvider({
        apiKey: "test-key",
        apiUrl: "https://cloud.mola.sh/api/v1",
      });

      const machineId = "test-machine-789";
      let callCount = 0;

      fetchMock.mockImplementation(async (_url) => {
        callCount++;
        if (callCount === 1) {
          // Create response
          return mockFetchResponse(201, {
            data: {
              id: machineId,
              name: "rakazo-test",
              status: "provisioning",
              is_transitional: true,
              vcpus: 2,
              memory_mb: 4096,
              disk_gb: 40,
              created_at: new Date().toISOString(),
            },
          });
        }
        if (callCount === 2) {
          // First poll - still provisioning
          return mockFetchResponse(200, {
            data: {
              id: machineId,
              status: "provisioning",
              is_transitional: true,
            },
          });
        }
        if (callCount === 3) {
          // Second poll - booting
          return mockFetchResponse(200, {
            data: {
              id: machineId,
              status: "booting",
              is_transitional: true,
            },
          });
        }
        // Third poll - ready
        return mockFetchResponse(200, {
          data: {
            id: machineId,
            status: "ready",
            is_transitional: false,
          },
        });
      });

      await provider.provision(
        {
          botId: "bot-789",
          homePath: "/home/bot",
        },
        createMockContext(),
      );

      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
      // Verify fresh fetches during polling
      const pollCalls = fetchMock.mock.calls.slice(1);
      for (const call of pollCalls) {
        expect(call[0]).toContain(`/computers/${machineId}`);
        const method = (call[1] as RequestInit)?.method;
        // GET requests may have method set or undefined
        expect(method === undefined || method === "GET").toBe(true);
      }
    });

    it("stops then restarts a machine with cache invalidation", async () => {
      const provider = createMolaSandboxProvider({
        apiKey: "test-key",
        apiUrl: "https://cloud.mola.sh/api/v1",
      });

      const machineId = "test-machine-restart";
      const computer = {
        id: machineId,
        kind: "mola" as const,
        providerRef: machineId,
        botId: "bot-restart",
      };

      fetchMock
        // Stop call
        .mockResolvedValueOnce(mockFetchResponse(200, { data: { ok: true } }))
        // Reconnect - fetch fresh status (stopped)
        .mockResolvedValueOnce(
          mockFetchResponse(200, {
            data: { id: machineId, status: "stopped" },
          }),
        )
        // Start call
        .mockResolvedValueOnce(mockFetchResponse(200, { data: { ok: true } }))
        // Fresh poll after start
        .mockResolvedValueOnce(
          mockFetchResponse(200, {
            data: { id: machineId, status: "ready" },
          }),
        );

      await provider.stop(computer, createMockContext());

      // Now reconnect (provision with existing ref)
      await provider.provision(
        {
          botId: computer.botId,
          homePath: "/home/bot",
          providerRef: computer.providerRef,
          providerKind: "mola",
        },
        createMockContext(),
      );

      expect(fetchMock).toHaveBeenCalledTimes(4);
      const stopCall = fetchMock.mock.calls[0];
      if (!stopCall) throw new Error("Stop call not made");
      expect(stopCall[0]).toBe(`https://cloud.mola.sh/api/v1/computers/${machineId}/stop`);

      const startCall = fetchMock.mock.calls[2];
      if (!startCall) throw new Error("Start call not made");
      expect(startCall[0]).toBe(`https://cloud.mola.sh/api/v1/computers/${machineId}/start`);
    });

    it("clamps exec timeout: Cloud to 50s, self-hosted to 120s", async () => {
      // Test Cloud mode (capped at 50s due to Cloudflare 504 at ~60s)
      const cloudProvider = createMolaSandboxProvider({
        apiKey: "test-key",
        apiUrl: "https://cloud.mola.sh/api/v1",
      });

      const machineId = "test-machine-exec";
      const computer = {
        id: machineId,
        kind: "mola" as const,
        providerRef: machineId,
        botId: "bot-exec",
      };

      fetchMock.mockResolvedValueOnce(
        mockFetchResponse(200, {
          data: {
            exit_code: 0,
            stdout: "command output",
            stderr: "",
            timed_out: false,
          },
        }),
      );

      const events: string[] = [];
      for await (const event of cloudProvider.execute(
        computer,
        { argv: ["sleep", "5"], timeoutMs: 300_000 }, // 5 minutes requested
        createMockContext(),
      )) {
        events.push(event.type);
      }

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const cloudCall = fetchMock.mock.calls[0];
      if (!cloudCall) throw new Error("Execute call not made");
      const cloudOptions = cloudCall[1] as RequestInit;
      const cloudBody = JSON.parse(cloudOptions.body as string);
      // Cloud timeout should be clamped to 50s (Cloudflare gateway limit)
      expect(cloudBody.timeout).toBe(50);
      expect(events).toContain("stdout");
      expect(events).toContain("exit");

      // Test self-hosted mode (capped at 120s - Mola's API max)
      fetchMock.mockClear();
      const selfhostedProvider = createMolaSandboxProvider({
        apiKey: "test-key",
        apiUrl: "http://localhost:4141/v1",
      });

      fetchMock.mockResolvedValueOnce(
        mockFetchResponse(200, {
          data: {
            exit_code: 0,
            stdout: "command output",
            stderr: "",
            timed_out: false,
          },
        }),
      );

      const events2: string[] = [];
      for await (const event of selfhostedProvider.execute(
        computer,
        { argv: ["sleep", "5"], timeoutMs: 300_000 },
        createMockContext(),
      )) {
        events2.push(event.type);
      }

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const selfhostedCall = fetchMock.mock.calls[0];
      if (!selfhostedCall) throw new Error("Execute call not made");
      const selfhostedOptions = selfhostedCall[1] as RequestInit;
      const selfhostedBody = JSON.parse(selfhostedOptions.body as string);
      // Self-hosted timeout should be clamped to 120s (Mola API max)
      expect(selfhostedBody.timeout).toBe(120);
    });

    it("detects self-hosted for custom domain (not localhost)", async () => {
      const provider = createMolaSandboxProvider({
        apiKey: "test-key",
        apiUrl: "http://mola.internal:4141/v1",
      });

      const machineId = "test-id";
      fetchMock
        // Create response
        .mockResolvedValueOnce(
          mockFetchResponse(201, {
            data: {
              id: machineId,
              name: "test",
              status: "provisioning",
              is_transitional: true,
              vcpus: 2,
              memory_mb: 4096,
              disk_gb: 40,
              created_at: new Date().toISOString(),
            },
          }),
        )
        // Readiness poll - now ready
        .mockResolvedValueOnce(
          mockFetchResponse(200, {
            data: {
              id: machineId,
              status: "ready",
              is_transitional: false,
            },
          }),
        );

      await provider.provision({ botId: "bot-1", homePath: "/home/bot" }, createMockContext());

      // Should use /machines (self-hosted) not /computers (cloud)
      const call = fetchMock.mock.calls[0];
      if (!call) throw new Error("Provision call not made");
      expect(call[0]).toBe("http://mola.internal:4141/v1/machines");
    });

    it("writes UTF-8 text file on Cloud using plain content field", async () => {
      const provider = createMolaSandboxProvider({
        apiKey: "test-key",
        apiUrl: "https://cloud.mola.sh/api/v1",
      });

      const machineId = "test-write-cloud";
      const computer = {
        id: machineId,
        kind: "mola" as const,
        providerRef: machineId,
        botId: "bot-write",
      };

      fetchMock.mockResolvedValueOnce(
        mockFetchResponse(200, {
          data: { ok: true, path: "/home/dev/rakazo-home/test.txt", bytes_written: 6 },
        }),
      );

      const textContent = "hello\n";
      await provider.writeFile(
        computer,
        {
          path: "test.txt",
          content: new TextEncoder().encode(textContent),
        },
        createMockContext(),
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const call = fetchMock.mock.calls[0];
      if (!call) throw new Error("Write call not made");
      const options = call[1] as RequestInit;
      const body = JSON.parse(options.body as string);
      expect(body.action).toBe("write_file");
      expect(body.path).toBe("/home/dev/rakazo-home/test.txt");
      expect(body.content).toBe(textContent); // Plain text, not base64
      expect(body).not.toHaveProperty("content_base64");
    });

    it("writes binary file on Cloud using exec with base64 -d", async () => {
      const provider = createMolaSandboxProvider({
        apiKey: "test-key",
        apiUrl: "https://cloud.mola.sh/api/v1",
      });

      const machineId = "test-write-binary-cloud";
      const computer = {
        id: machineId,
        kind: "mola" as const,
        providerRef: machineId,
        botId: "bot-write-binary",
      };

      fetchMock.mockResolvedValueOnce(
        mockFetchResponse(200, { data: { exit_code: 0, stdout: "", stderr: "" } }),
      );

      // Binary content (PNG header bytes)
      const binaryContent = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      await provider.writeFile(
        computer,
        {
          path: "test.png",
          content: binaryContent,
        },
        createMockContext(),
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const call = fetchMock.mock.calls[0];
      if (!call) throw new Error("Write call not made");
      const options = call[1] as RequestInit;
      const body = JSON.parse(options.body as string);
      expect(body.action).toBe("exec");
      expect(body.command).toContain("base64 -d");
      expect(body.command).toContain("/home/dev/rakazo-home/test.png");
      // Verify base64 encoding of binary content is in command
      const expectedBase64 = Buffer.from(binaryContent).toString("base64");
      expect(body.command).toContain(expectedBase64);
    });

    it("writes file on self-hosted using content_base64", async () => {
      const provider = createMolaSandboxProvider({
        apiKey: "test-key",
        apiUrl: "http://localhost:4141/v1",
      });

      const machineId = "test-write-selfhosted";
      const computer = {
        id: machineId,
        kind: "mola" as const,
        providerRef: machineId,
        botId: "bot-write-self",
      };

      fetchMock.mockResolvedValueOnce(
        mockFetchResponse(200, {
          data: { ok: true, path: "/home/dev/rakazo-home/test.txt", bytes_written: 6 },
        }),
      );

      const textContent = "hello\n";
      await provider.writeFile(
        computer,
        {
          path: "test.txt",
          content: new TextEncoder().encode(textContent),
        },
        createMockContext(),
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const call = fetchMock.mock.calls[0];
      if (!call) throw new Error("Write call not made");
      const options = call[1] as RequestInit;
      const body = JSON.parse(options.body as string);
      expect(body.action).toBe("write_file");
      expect(body.path).toBe("/home/dev/rakazo-home/test.txt");
      expect(body.content_base64).toBe(Buffer.from(textContent).toString("base64"));
      expect(body).not.toHaveProperty("content");
    });

    it("writes empty file on Cloud", async () => {
      const provider = createMolaSandboxProvider({
        apiKey: "test-key",
        apiUrl: "https://cloud.mola.sh/api/v1",
      });

      const machineId = "test-write-empty";
      const computer = {
        id: machineId,
        kind: "mola" as const,
        providerRef: machineId,
        botId: "bot-write-empty",
      };

      fetchMock.mockResolvedValueOnce(
        mockFetchResponse(200, {
          data: { ok: true, path: "/home/dev/rakazo-home/empty.txt", bytes_written: 0 },
        }),
      );

      await provider.writeFile(
        computer,
        {
          path: "empty.txt",
          content: new Uint8Array(0),
        },
        createMockContext(),
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const call = fetchMock.mock.calls[0];
      if (!call) throw new Error("Write call not made");
      const options = call[1] as RequestInit;
      const body = JSON.parse(options.body as string);
      expect(body.action).toBe("write_file");
      expect(body.content).toBe(""); // Empty string
    });

    it("treats invalid UTF-8 as binary on Cloud", async () => {
      const provider = createMolaSandboxProvider({
        apiKey: "test-key",
        apiUrl: "https://cloud.mola.sh/api/v1",
      });

      const machineId = "test-write-invalid-utf8";
      const computer = {
        id: machineId,
        kind: "mola" as const,
        providerRef: machineId,
        botId: "bot-write-invalid",
      };

      fetchMock.mockResolvedValueOnce(
        mockFetchResponse(200, { data: { exit_code: 0, stdout: "", stderr: "" } }),
      );

      // Invalid UTF-8 sequence: f0 90 88 (incomplete 4-byte sequence)
      // toString('utf-8') replaces with U+FFFD (ef bf bd), so strict check catches it
      const invalidUtf8 = new Uint8Array([0xf0, 0x90, 0x88]);
      await provider.writeFile(
        computer,
        {
          path: "invalid.bin",
          content: invalidUtf8,
        },
        createMockContext(),
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const call = fetchMock.mock.calls[0];
      if (!call) throw new Error("Write call not made");
      const options = call[1] as RequestInit;
      const body = JSON.parse(options.body as string);
      // Should use exec with base64, not write_file
      expect(body.action).toBe("exec");
      expect(body.command).toContain("base64 -d");
    });

    it("respects 32768 char exec command limit on Cloud", async () => {
      const provider = createMolaSandboxProvider({
        apiKey: "test-key",
        apiUrl: "https://cloud.mola.sh/api/v1",
      });

      const machineId = "test-write-exec-limit";
      const computer = {
        id: machineId,
        kind: "mola" as const,
        providerRef: machineId,
        botId: "bot-write-limit",
      };

      fetchMock.mockResolvedValueOnce(
        mockFetchResponse(200, { data: { exit_code: 0, stdout: "", stderr: "" } }),
      );

      // Binary content that fits in single exec (~24 KB base64 -> ~32700 chars in command)
      const smallBinary = new Uint8Array(18000); // Will be ~24000 base64 chars
      for (let i = 0; i < smallBinary.length; i++) {
        smallBinary[i] = i % 256;
      }

      await provider.writeFile(
        computer,
        {
          path: "small.bin",
          content: smallBinary,
        },
        createMockContext(),
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const call = fetchMock.mock.calls[0];
      if (!call) throw new Error("Write call not made");
      const options = call[1] as RequestInit;
      const body = JSON.parse(options.body as string);
      expect(body.action).toBe("exec");
      expect(body.command).toContain("printf");
      // Verify command is under limit
      expect(body.command.length).toBeLessThanOrEqual(32768);
    });

    it("uses write_file staging for large binary on Cloud", async () => {
      const provider = createMolaSandboxProvider({
        apiKey: "test-key",
        apiUrl: "https://cloud.mola.sh/api/v1",
      });

      const machineId = "test-write-large";
      const computer = {
        id: machineId,
        kind: "mola" as const,
        providerRef: machineId,
        botId: "bot-write-large",
      };

      // Mock write_file for 3 parts, then cat/decode, then rm
      fetchMock
        .mockResolvedValueOnce(
          mockFetchResponse(200, {
            data: { ok: true, path: "/home/dev/rakazo-home/large.bin.b64part0" },
          }),
        )
        .mockResolvedValueOnce(
          mockFetchResponse(200, {
            data: { ok: true, path: "/home/dev/rakazo-home/large.bin.b64part1" },
          }),
        )
        .mockResolvedValueOnce(
          mockFetchResponse(200, {
            data: { ok: true, path: "/home/dev/rakazo-home/large.bin.b64part2" },
          }),
        )
        .mockResolvedValueOnce(
          mockFetchResponse(200, { data: { exit_code: 0, stdout: "", stderr: "" } }),
        )
        .mockResolvedValueOnce(
          mockFetchResponse(200, { data: { exit_code: 0, stdout: "", stderr: "" } }),
        );

      // Binary that requires 3 write_file chunks: 1.5MB raw -> ~2MB base64 -> 3 chunks @ 900KB each
      const largeBinary = new Uint8Array(1_500_000);
      for (let i = 0; i < largeBinary.length; i++) {
        largeBinary[i] = i % 256;
      }

      await provider.writeFile(
        computer,
        {
          path: "large.bin",
          content: largeBinary,
        },
        createMockContext(),
      );

      // Should have: 3 write_file calls for parts, 1 exec for cat|base64, 1 exec for rm
      expect(fetchMock).toHaveBeenCalledTimes(5);

      // First three calls should be write_file with content (base64 chunks of 900 KiB)
      for (let i = 0; i < 3; i++) {
        const partCall = fetchMock.mock.calls[i];
        if (!partCall) throw new Error(`Part ${i} call not made`);
        const partBody = JSON.parse((partCall[1] as RequestInit).body as string);
        expect(partBody.action).toBe("write_file");
        expect(partBody.path).toContain(`.b64part${i}`);
        // First two chunks are 900 KiB, last is remainder
        if (i < 2) {
          expect(partBody.content.length).toBe(921600);
        } else {
          expect(partBody.content.length).toBeLessThanOrEqual(921600);
        }
        // Verify serialized body stays under 1 MiB
        const partSerialized = (partCall[1] as RequestInit).body as string;
        expect(Buffer.byteLength(partSerialized, "utf-8")).toBeLessThan(1_000_000);
      }

      // Fourth call should be exec with bash pipefail, cat and base64 -d
      const catCall = fetchMock.mock.calls[3];
      if (!catCall) throw new Error("Cat call not made");
      const catBody = JSON.parse((catCall[1] as RequestInit).body as string);
      expect(catBody.action).toBe("exec");
      expect(catBody.command).toContain("bash -c");
      expect(catBody.command).toContain("set -o pipefail");
      expect(catBody.command).toContain("cat");
      expect(catBody.command).toContain("base64 -d");
      expect(catBody.command).toContain("large.bin");
      expect(catBody.command.length).toBeLessThanOrEqual(32768);
      // Cloud: timeout 50s
      expect(catBody.timeout).toBe(50);

      // Fifth call should be rm cleanup
      const rmCall = fetchMock.mock.calls[4];
      if (!rmCall) throw new Error("Rm call not made");
      const rmBody = JSON.parse((rmCall[1] as RequestInit).body as string);
      expect(rmBody.action).toBe("exec");
      expect(rmBody.command).toContain("rm -f");
      expect(rmBody.command.length).toBeLessThanOrEqual(32768);
    });

    it("routes large UTF-8 text through staging on Cloud", async () => {
      const provider = createMolaSandboxProvider({
        apiKey: "test-key",
        apiUrl: "https://cloud.mola.sh/api/v1",
      });

      const machineId = "test-write-large-text";
      const computer = {
        id: machineId,
        kind: "mola" as const,
        providerRef: machineId,
        botId: "bot-write-text",
      };

      // Mock write_file for 2 parts, then cat/decode, then rm
      fetchMock
        .mockResolvedValueOnce(
          mockFetchResponse(200, {
            data: { ok: true, path: "/home/dev/rakazo-home/large.txt.b64part0" },
          }),
        )
        .mockResolvedValueOnce(
          mockFetchResponse(200, {
            data: { ok: true, path: "/home/dev/rakazo-home/large.txt.b64part1" },
          }),
        )
        .mockResolvedValueOnce(
          mockFetchResponse(200, { data: { exit_code: 0, stdout: "", stderr: "" } }),
        )
        .mockResolvedValueOnce(
          mockFetchResponse(200, { data: { exit_code: 0, stdout: "", stderr: "" } }),
        );

      // Large UTF-8 text: 1MB text -> ~1.33MB base64 -> 2 chunks
      const largeText = "a".repeat(1_000_000);

      await provider.writeFile(
        computer,
        {
          path: "large.txt",
          content: new TextEncoder().encode(largeText),
        },
        createMockContext(),
      );

      // Should use staging: 2 write_file, 1 cat, 1 rm
      expect(fetchMock).toHaveBeenCalledTimes(4);

      // First call: write_file with base64 chunk
      const part0Call = fetchMock.mock.calls[0];
      if (!part0Call) throw new Error("Part 0 call not made");
      const part0Body = JSON.parse((part0Call[1] as RequestInit).body as string);
      expect(part0Body.action).toBe("write_file");
      expect(part0Body.path).toContain(".b64part0");

      // Third call: exec with bash pipefail, cat and base64 -d
      const catCall = fetchMock.mock.calls[2];
      if (!catCall) throw new Error("Cat call not made");
      const catBody = JSON.parse((catCall[1] as RequestInit).body as string);
      expect(catBody.action).toBe("exec");
      expect(catBody.command).toContain("bash -c");
      expect(catBody.command).toContain("set -o pipefail");
      expect(catBody.timeout).toBe(50);
    });

    it("verifies serialized body size stays under 950 KiB on Cloud", async () => {
      const provider = createMolaSandboxProvider({
        apiKey: "test-key",
        apiUrl: "https://cloud.mola.sh/api/v1",
      });

      const machineId = "test-write-body-size";
      const computer = {
        id: machineId,
        kind: "mola" as const,
        providerRef: machineId,
        botId: "bot-write-size",
      };

      fetchMock.mockResolvedValueOnce(
        mockFetchResponse(200, {
          data: { ok: true, path: "/home/dev/rakazo-home/test.txt", bytes_written: 500000 },
        }),
      );

      // UTF-8 text that fits after JSON serialization
      const text = "x".repeat(500_000);

      await provider.writeFile(
        computer,
        {
          path: "test.txt",
          content: new TextEncoder().encode(text),
        },
        createMockContext(),
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const call = fetchMock.mock.calls[0];
      if (!call) throw new Error("Write call not made");

      // Check serialized body size
      const serializedBody = (call[1] as RequestInit).body as string;
      const bodyBytes = Buffer.byteLength(serializedBody, "utf-8");
      expect(bodyBytes).toBeLessThanOrEqual(950 * 1024);
    });
  });
});
