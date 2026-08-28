import { spawnSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { resolveSupervisorToken } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { resolveDockerSocketPath, supervisorApp, waitForScreenReady } from "./index.js";
import {
  assertRequestIdentity,
  attemptComputerControl,
  ComputerControlUnavailableError,
  clearComputerScreenRegistry,
  completeReleasedScreen,
  computerControlTimeoutMs,
  containerActionStep,
  demuxDockerStream,
  ensureScreenCommand,
  hasValidBearerToken,
  interactiveScreenCommand,
  isComputerControlUnavailable,
  nextScreenIndex,
  normalizeWorkspaceRelative,
  parseObservation,
  preferComputerControl,
  releaseAssignedScreen,
  type ScreenAssignment,
  sandboxCommandTimedOut,
  sandboxTimeoutCommand,
  shouldReplayComputerActions,
  stopExtraScreenCommand,
} from "./supervisor-logic.js";

const token = resolveSupervisorToken(process.env);

describe("computer screen readiness", () => {
  it("waits for the server to actually answer HTTP requests before succeeding", async () => {
    const server = http.createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a TCP address");
    try {
      await expect(waitForScreenReady("127.0.0.1", address.port, 2_000)).resolves.toBe(true);
    } finally {
      server.close();
    }
  });

  it("does not treat an open TCP port as ready when nothing is serving HTTP on it yet", async () => {
    // Regression test: a bare TCP accept (e.g. the Docker port mapping coming
    // up before websockify inside the container does) must not be mistaken
    // for the screen being ready — that gap is exactly what caused
    // "socket hang up" in the browser.
    const server = net.createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a TCP address");
    try {
      await expect(waitForScreenReady("127.0.0.1", address.port, 700)).resolves.toBe(false);
    } finally {
      server.close();
    }
  });

  it("does not treat HTTP error responses as ready", async () => {
    const server = http.createServer((_req, res) => {
      res.statusCode = 503;
      res.end("starting");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a TCP address");
    try {
      await expect(waitForScreenReady("127.0.0.1", address.port, 700)).resolves.toBe(false);
    } finally {
      server.close();
    }
  });

  it("does not treat redirect responses as ready", async () => {
    const server = http.createServer((_req, res) => {
      res.statusCode = 302;
      res.setHeader("Location", "/vnc.html");
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a TCP address");
    try {
      await expect(waitForScreenReady("127.0.0.1", address.port, 700)).resolves.toBe(false);
    } finally {
      server.close();
    }
  });

  it("times out instead of hanging when nothing is listening", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a TCP address");
    const closedPort = address.port;
    await new Promise<void>((resolve) => server.close(() => resolve()));

    await expect(waitForScreenReady("127.0.0.1", closedPort, 700)).resolves.toBe(false);
  });
});

describe("sandbox supervisor Docker endpoint", () => {
  it("respects Docker host and socket overrides before platform defaults", () => {
    expect(resolveDockerSocketPath({ DOCKER_HOST: "tcp://docker.test:2375" }, "win32")).toBe(
      undefined,
    );
    expect(resolveDockerSocketPath({ DOCKER_SOCKET: "/tmp/docker.sock" }, "win32")).toBe(
      "/tmp/docker.sock",
    );
    expect(resolveDockerSocketPath({}, "win32")).toBe("//./pipe/docker_engine");
    expect(resolveDockerSocketPath({}, "linux")).toBe("/var/run/docker.sock");
  });
});

describe("sandbox supervisor HTTP boundary", () => {
  it("keeps health public while every computer route requires the service token", async () => {
    const health = await supervisorApp.request("/health");
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ ok: true });

    const protectedRequests: Array<[string, string]> = [
      ["POST", "/computers"],
      ["GET", "/computers/id"],
      ["POST", "/computers/id/exec"],
      ["POST", "/computers/id/observe"],
      ["POST", "/computers/id/actions"],
      ["GET", "/computers/id/files"],
      ["POST", "/computers/id/files"],
      ["GET", "/computers/id/screen"],
      ["POST", "/computers/id/screen-mode"],
      ["DELETE", "/computers/id/screen"],
      ["POST", "/computers/id/input"],
      ["POST", "/computers/id/stop"],
      ["DELETE", "/computers/id"],
    ];

    for (const [method, pathname] of protectedRequests) {
      const response = await supervisorApp.request(pathname, { method });
      expect(response.status, `${method} ${pathname}`).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    }
  });

  it("rejects malformed and incorrect bearer credentials", () => {
    expect(hasValidBearerToken(undefined, token)).toBe(false);
    expect(hasValidBearerToken(token, token)).toBe(false);
    expect(hasValidBearerToken("Basic credentials", token)).toBe(false);
    expect(hasValidBearerToken(`Bearer ${"x".repeat(token.length)}`, token)).toBe(false);
    expect(hasValidBearerToken(`Bearer ${token}`, token)).toBe(true);
  });

  it("rejects a provision request whose identity headers do not match its body", async () => {
    const response = await supervisorApp.request("/computers", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-rakazo-bot-id": "other-bot",
        "x-rakazo-workspace-id": "workspace",
      },
      body: JSON.stringify({
        botId: "bot",
        workspaceId: "workspace",
        homePath: "/tmp/never-used",
      }),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "computer identity mismatch" });
  });
});

describe("sandbox supervisor input containment", () => {
  it("normalizes portable paths and rejects lexical traversal", () => {
    expect(normalizeWorkspaceRelative("/notes\\result.txt")).toBe("notes/result.txt");
    expect(normalizeWorkspaceRelative("//notes///result.txt")).toBe("notes/result.txt");
    expect(() => normalizeWorkspaceRelative("../outside")).toThrow(/escapes/);
    expect(() => normalizeWorkspaceRelative("notes/./result.txt")).toThrow(/escapes/);
    expect(() => normalizeWorkspaceRelative("notes/../outside")).toThrow(/escapes/);
  });

  it("requires both bot and workspace identities to match", () => {
    expect(() =>
      assertRequestIdentity("bot", "workspace", { botId: "bot", workspaceId: "workspace" }),
    ).not.toThrow();
    expect(() =>
      assertRequestIdentity(undefined, "workspace", { botId: "bot", workspaceId: "workspace" }),
    ).toThrow(/identity mismatch/);
    expect(() =>
      assertRequestIdentity("bot", "other", { botId: "bot", workspaceId: "workspace" }),
    ).toThrow(/identity mismatch/);
  });

  it("bounds scroll and wait actions before sending them to the computer", () => {
    expect(containerActionStep({ kind: "wait", ms: 99_999 })).toEqual({ waitMs: 5_000 });
    expect(containerActionStep({ kind: "wait", ms: -1 })).toEqual({ waitMs: 0 });
    expect(containerActionStep({ kind: "scroll", direction: "up", amount: 99 })).toEqual({
      argv: ["env", "DISPLAY=:1", "xdotool", "click", "--repeat", "20", "4"],
    });
  });

  it("falls back to docker-exec when computer control fails", async () => {
    await expect(
      preferComputerControl(
        async () => {
          throw new Error("connection refused");
        },
        async () => "docker-exec",
      ),
    ).resolves.toBe("docker-exec");
    await expect(preferComputerControl(undefined, async () => "docker-exec")).resolves.toBe(
      "docker-exec",
    );
    await expect(
      preferComputerControl(
        async () => "fast-path",
        async () => "docker-exec",
      ),
    ).resolves.toBe("fast-path");
  });

  it("replays actions only when control was never reached", async () => {
    await expect(attemptComputerControl(undefined)).resolves.toEqual({ status: "unavailable" });
    await expect(
      attemptComputerControl(async () => {
        throw new ComputerControlUnavailableError("fetch failed");
      }),
    ).resolves.toEqual({ status: "unavailable" });
    await expect(
      attemptComputerControl(async () => {
        throw new Error("computer action failed");
      }),
    ).resolves.toMatchObject({ status: "failed" });
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), {
      name: "TimeoutError",
    });
    await expect(
      attemptComputerControl(async () => {
        throw timeout;
      }),
    ).resolves.toMatchObject({ status: "failed" });
    expect(isComputerControlUnavailable(new TypeError("fetch failed"))).toBe(false);
    expect(
      isComputerControlUnavailable(
        Object.assign(new TypeError("fetch failed"), {
          cause: new Error("connect ECONNREFUSED 127.0.0.1:7070"),
        }),
      ),
    ).toBe(true);
    expect(
      isComputerControlUnavailable(
        Object.assign(new TypeError("fetch failed"), {
          cause: new Error("connect ENETUNREACH 172.18.0.4:7070"),
        }),
      ),
    ).toBe(true);
    expect(
      isComputerControlUnavailable(
        Object.assign(new TypeError("fetch failed"), {
          cause: new Error("read ECONNRESET"),
        }),
      ),
    ).toBe(false);
    expect(isComputerControlUnavailable(timeout)).toBe(false);
    await expect(attemptComputerControl(async () => ({ completed: 2 }))).resolves.toEqual({
      status: "ok",
      value: { completed: 2 },
    });
  });

  it("falls back on connection refused but does not replay after a request-sent failure", async () => {
    const refused = await attemptComputerControl(async () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: new Error("connect ECONNREFUSED 172.18.0.4:7070"),
      });
    });
    expect(refused).toEqual({ status: "unavailable" });
    expect(shouldReplayComputerActions(refused)).toBe(true);

    const afterWrite = await attemptComputerControl(async () => {
      throw new Error("computer control failed");
    });
    expect(afterWrite).toMatchObject({ status: "failed" });
    expect(shouldReplayComputerActions(afterWrite)).toBe(false);

    const timedOut = await attemptComputerControl(async () => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), {
        name: "TimeoutError",
      });
    });
    expect(timedOut).toMatchObject({ status: "failed" });
    expect(shouldReplayComputerActions(timedOut)).toBe(false);

    const reset = await attemptComputerControl(async () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: new Error("read ECONNRESET"),
      });
    });
    expect(reset).toMatchObject({ status: "failed" });
    expect(shouldReplayComputerActions(reset)).toBe(false);
  });

  it("extends the computer control deadline for mapped waits", () => {
    expect(computerControlTimeoutMs([])).toBe(15_000);
    expect(computerControlTimeoutMs([{ kind: "wait", ms: 5_000 }], 5_000)).toBe(25_000);
    expect(
      computerControlTimeoutMs(
        [
          { kind: "wait", ms: 5_000 },
          { kind: "wait", ms: 5_000 },
          { kind: "wait", ms: 5_000 },
          { kind: "wait", ms: 5_000 },
          { kind: "wait", ms: 5_000 },
          { kind: "wait", ms: 5_000 },
          { kind: "wait", ms: 5_000 },
          { kind: "wait", ms: 5_000 },
          { kind: "wait", ms: 5_000 },
          { kind: "wait", ms: 5_000 },
        ],
        5_000,
      ),
    ).toBe(60_000);
  });

  it("wraps sandbox commands in a process-tree timeout", () => {
    expect(sandboxTimeoutCommand(["bash", "-lc", "sleep 10"], 2_500, "/tmp/completed-124")).toEqual(
      [
        "timeout",
        "--kill-after=1s",
        "2.5s",
        "sh",
        "-c",
        '"$@"; status=$?; if [ "$status" -eq 124 ]; then : > "$0"; fi; exit "$status"',
        "/tmp/completed-124",
        "bash",
        "-lc",
        "sleep 10",
      ],
    );
    expect(sandboxCommandTimedOut(124, false)).toBe(true);
    expect(sandboxCommandTimedOut(124, true)).toBe(false);
    expect(sandboxCommandTimedOut(1, false)).toBe(false);
  });

  it("keeps the viewer read-only and uses a separate process for takeover control", () => {
    expect(interactiveScreenCommand(false)).toMatch(/pkill .*5901/);
    expect(interactiveScreenCommand(false)).not.toMatch(/x11vnc -display/);
    expect(interactiveScreenCommand(true, "lease-new")).toMatch(/x11vnc -display .* -rfbport 5901/);
    expect(interactiveScreenCommand(true, "lease-new")).toMatch(/6081/);
    expect(interactiveScreenCommand(true, "lease-new")).not.toMatch(/-rfbport 5900/);
    expect(interactiveScreenCommand(false, "lease-old")).toContain("!= 'lease-old'");
  });

  it("assigns distinct screen indexes per Team bot and starts extra displays", () => {
    const assigned = new Map<string, ScreenAssignment>();
    expect(nextScreenIndex(assigned, "writer")).toBe(0);
    expect(nextScreenIndex(assigned, "researcher")).toBe(1);
    expect(nextScreenIndex(assigned, "writer")).toBe(0);
    expect(ensureScreenCommand(0)).toContain("-display :1");
    expect(ensureScreenCommand(0)).toContain("seq 1 100");
    expect(ensureScreenCommand(1)).toContain("Xvfb :2");
    expect(ensureScreenCommand(1)).toContain("rfbport 5902");
    expect(ensureScreenCommand(1)).toContain("0.0.0.0:6082");
    expect(() => nextScreenIndex(assigned, "overflow", undefined, 1)).toThrow(
      /cannot allocate another screen/,
    );
  });

  it("generates syntactically valid shell to start an extra display", () => {
    const result = spawnSync("bash", ["-n"], { input: ensureScreenCommand(1) });
    expect(result.status).toBe(0);
    expect(result.stderr.toString()).toBe("");
  });

  it("frees a released screen slot so a ninth Team bot can reuse it", () => {
    const assigned = new Map<string, ScreenAssignment>();
    for (let index = 0; index < 8; index += 1) {
      expect(nextScreenIndex(assigned, `bot-${index}`)).toBe(index);
    }
    expect(() => nextScreenIndex(assigned, "bot-8")).toThrow(/cannot allocate another screen/);
    expect(releaseAssignedScreen(assigned, "bot-3")).toBe(3);
    expect(assigned.get("bot-0")?.index).toBe(0);
    expect(assigned.get("bot-3")?.releasing).toBe(true);
    expect(() => nextScreenIndex(assigned, "bot-3")).toThrow(/still being released/);
    expect(() => nextScreenIndex(assigned, "bot-8")).toThrow(/cannot allocate another screen/);
    completeReleasedScreen(assigned, "bot-3", 3);
    expect(assigned.get("bot-3")).toBeUndefined();
    expect(nextScreenIndex(assigned, "bot-8")).toBe(3);
    expect(nextScreenIndex(assigned, "bot-0")).toBe(0);
    expect(releaseAssignedScreen(assigned, "missing")).toBeUndefined();
    expect(() => nextScreenIndex(assigned, "bot-9")).toThrow(/cannot allocate another screen/);
  });

  it("clears all screen assignments when a container stops so slots can be reused", () => {
    const registry = new Map<string, Map<string, ScreenAssignment>>();
    const containerId = "container-1";
    const assigned = new Map<string, ScreenAssignment>();
    registry.set(containerId, assigned);
    for (let index = 0; index < 8; index += 1) {
      nextScreenIndex(assigned, `bot-${index}`);
    }
    expect(() => nextScreenIndex(assigned, "bot-8")).toThrow(/cannot allocate another screen/);

    clearComputerScreenRegistry(registry, containerId);
    expect(registry.has(containerId)).toBe(false);

    const fresh = new Map<string, ScreenAssignment>();
    registry.set(containerId, fresh);
    for (let index = 0; index < 8; index += 1) {
      expect(nextScreenIndex(fresh, `bot-fresh-${index}`)).toBe(index);
    }
  });

  it("does not release a screen reclaimed by a newer execution fence", () => {
    const assigned = new Map<string, ScreenAssignment>();
    expect(nextScreenIndex(assigned, "writer", "run-1:1")).toBe(0);
    expect(nextScreenIndex(assigned, "writer", "run-2:2")).toBe(0);
    expect(releaseAssignedScreen(assigned, "writer", "run-1:1")).toBeUndefined();
    expect(nextScreenIndex(assigned, "researcher")).toBe(1);
    expect(releaseAssignedScreen(assigned, "writer", "run-2:2")).toBe(0);
    completeReleasedScreen(assigned, "writer", 0);
  });

  it("releases a retained screen after the same run resumes", () => {
    const assigned = new Map<string, ScreenAssignment>();
    expect(nextScreenIndex(assigned, "writer", "run-1:1")).toBe(0);
    expect(releaseAssignedScreen(assigned, "writer", "run-1:8")).toBe(0);
    completeReleasedScreen(assigned, "writer", 0);
    expect(nextScreenIndex(assigned, "researcher")).toBe(0);
  });

  it("does not let a delayed request restore an older lease", () => {
    const assigned = new Map<string, ScreenAssignment>();
    expect(nextScreenIndex(assigned, "writer", "run-2:2")).toBe(0);
    expect(() => nextScreenIndex(assigned, "writer", "run-1:1")).toThrow(
      /owned by a newer execution/,
    );
    expect(releaseAssignedScreen(assigned, "writer", "run-1:1")).toBeUndefined();
    expect(releaseAssignedScreen(assigned, "writer", "run-2:2")).toBe(0);
  });

  it("stops extra displays without touching the primary desktop", () => {
    expect(stopExtraScreenCommand(0)).toBe("");
    expect(stopExtraScreenCommand(1)).toContain("Xvfb :2 -screen");
    expect(stopExtraScreenCommand(1)).toContain("rfbport 5902");
    expect(stopExtraScreenCommand(1)).toContain("websockify.*6082");
    expect(stopExtraScreenCommand(1)).not.toMatch(/Xvfb :1 /);
    expect(stopExtraScreenCommand(1)).not.toMatch(/6080/);
  });

  it("parses a captured frame without trusting optional desktop metadata", () => {
    expect(
      parseObservation(
        [
          "GEOM 1280 800",
          "CURSOR X=12 Y=34 SCREEN=0 WINDOW=99",
          "WINDOW 99",
          "TITLE Browser",
          "IMAGE AQID",
        ].join("\n"),
      ),
    ).toEqual({
      image: "AQID",
      mimeType: "image/png",
      width: 1280,
      height: 800,
      cursor: { x: 12, y: 34 },
      activeWindow: { id: "99", title: "Browser" },
    });
    expect(() => parseObservation("GEOM 1280 800\nIMAGE ")).toThrow(/no image/);
  });
});

describe("docker exec stream demux", () => {
  const frame = (type: number, text: string) => {
    const payload = Buffer.from(text, "utf8");
    const header = Buffer.alloc(8);
    header[0] = type;
    header.writeUInt32BE(payload.length, 4);
    return Buffer.concat([header, payload]);
  };

  it("keeps stderr frames out of stdout", () => {
    const stream = Buffer.concat([
      frame(1, "aGVsbG8="),
      frame(2, "python: DeprecationWarning\n"),
      frame(1, "\n"),
    ]);
    expect(demuxDockerStream(stream)).toEqual({
      stdout: "aGVsbG8=\n",
      stderr: "python: DeprecationWarning\n",
    });
  });

  it("treats a raw tty stream as stdout", () => {
    expect(demuxDockerStream(Buffer.from("plain output\n"))).toEqual({
      stdout: "plain output\n",
      stderr: "",
    });
    expect(demuxDockerStream(Buffer.alloc(0))).toEqual({ stdout: "", stderr: "" });
  });

  it("falls back to raw stdout when the stream is not a complete multiplexed sequence", () => {
    const cut = Buffer.concat([frame(1, "kept"), frame(2, "truncated stderr")]).subarray(
      0,
      12 + 8 + 6,
    );
    expect(demuxDockerStream(cut)).toEqual({ stdout: cut.toString("utf8"), stderr: "" });
    const dangling = Buffer.concat([frame(1, "ok"), Buffer.from([1, 0, 0])]);
    expect(demuxDockerStream(dangling)).toEqual({
      stdout: dangling.toString("utf8"),
      stderr: "",
    });
  });

  it("treats raw payloads that begin with 0x01 or 0x02 as stdout when not valid frames", () => {
    // size 0xffffffff does not fit remaining bytes → not a complete multiplexed stream
    const raw01 = Buffer.from([0x01, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0x41, 0x42]);
    expect(demuxDockerStream(raw01)).toEqual({
      stdout: raw01.toString("utf8"),
      stderr: "",
    });
    const raw02 = Buffer.from([0x02, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0x43, 0x44]);
    expect(demuxDockerStream(raw02)).toEqual({
      stdout: raw02.toString("utf8"),
      stderr: "",
    });
  });

  it("rejects frames with nonzero reserved header padding as raw stdout", () => {
    // type 1, nonzero padding, size 0 — would look like an empty stdout frame without the check
    const padded = Buffer.from([0x01, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00]);
    expect(demuxDockerStream(padded)).toEqual({
      stdout: padded.toString("utf8"),
      stderr: "",
    });
  });
});
