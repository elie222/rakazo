import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { serve } from "@hono/node-server";
import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { DockerSandboxProvider, resolveComputerTargets } from "@rakazo/adapters";
import { pollUntil } from "@rakazo/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computerReplayContext } from "./computer-replay.js";

interface Fixture {
  computer: ComputerRef;
  context: AdapterContext;
}

const WINDOW_TIMEOUT_MS = 90_000;

/**
 * Semantic perception against real native windows in the computer image. Every case reads the
 * AT-SPI tree the helper publishes, so a change to the image, the helper or the adapter shows up
 * here; it runs only through `pnpm test:computer-replay`, which supplies the supervisor's
 * environment.
 */
describe.skipIf(process.env.RUN_COMPUTER_REPLAY_DOCKER !== "1")(
  "computer perception against real native windows",
  () => {
    let server: Server;
    let sandbox: DockerSandboxProvider;
    const provisioned: Fixture[] = [];

    beforeAll(async () => {
      if (!process.env.DATA_DIR || !process.env.SANDBOX_SUPERVISOR_TOKEN) {
        throw new Error("Run through pnpm test:computer-replay to create a supervisor environment");
      }
      const { supervisorApp } = await import("@rakazo/sandbox-supervisor");
      server = serve({ fetch: supervisorApp.fetch, hostname: "127.0.0.1", port: 0 }) as Server;
      if (!server.listening) await once(server, "listening");
      const port = (server.address() as AddressInfo).port;
      sandbox = new DockerSandboxProvider(
        `http://127.0.0.1:${port}`,
        process.env.SANDBOX_SUPERVISOR_TOKEN,
      );
    });

    afterAll(async () => {
      for (const { computer, context } of provisioned.splice(0)) {
        await sandbox
          .destroy(computer, { ...context, signal: AbortSignal.timeout(30_000) })
          .catch(() => undefined);
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) =>
          error && (!("code" in error) || error.code !== "ERR_SERVER_NOT_RUNNING")
            ? reject(error)
            : resolve(),
        );
        server.closeAllConnections();
      });
    });

    async function provision(): Promise<Fixture> {
      const context: AdapterContext = {
        ...computerReplayContext(),
        botId: `perception-${randomUUID()}`,
        signal: AbortSignal.timeout(240_000),
      };
      const homePath = path.join(process.env.DATA_DIR!, "homes", context.botId!);
      await mkdir(homePath, { recursive: true });
      const computer = await sandbox.provision({ botId: context.botId!, homePath }, context);
      await sandbox.prepare(computer, context);
      const fixture = { computer, context };
      provisioned.push(fixture);
      return fixture;
    }

    async function shell(fixture: Fixture, command: string) {
      let stderr = "";
      for await (const event of sandbox.execute(
        fixture.computer,
        { argv: ["bash", "-lc", command] },
        fixture.context,
      )) {
        if (event.type === "stderr") stderr += event.data;
        else if (event.type === "exit" && event.code !== 0) {
          throw new Error(`command failed with ${event.code}: ${stderr}`);
        }
      }
    }

    /**
     * Launch a native application, detached so the command returns while the window stays up.
     * Reading the screen first is what `launch_app` does: the desktop, and the accessibility bus
     * an application registers with, exist before any window opens.
     */
    async function launch(fixture: Fixture, argv: string) {
      await sandbox.observe(fixture.computer, fixture.context);
      await shell(
        fixture,
        `nohup ${argv} >/tmp/rakazo/${path.basename(argv.split(" ")[0]!)}.log 2>&1 &`,
      );
    }

    /** The window title of every element the tree lists, which is what a navigation changes. */
    async function windowTitles(fixture: Fixture) {
      const result = await pollUntil(
        async () => {
          const found = await sandbox.findElements!(
            fixture.computer,
            { app: "thunar", limit: 300 },
            fixture.context,
          );
          return found.unknown || found.elements.length === 0 ? null : found;
        },
        {
          intervalMs: 500,
          timeoutMs: WINDOW_TIMEOUT_MS,
          waitingFor: "thunar to publish its window",
        },
      );
      return new Set(result.elements.map((element) => element.window ?? ""));
    }

    /** Wait for the folder the window names, which is how a navigation shows it worked. */
    async function waitForWindowNamed(fixture: Fixture, title: string) {
      return pollUntil(async () => ((await windowTitles(fixture)).has(title) ? true : null), {
        intervalMs: 250,
        timeoutMs: WINDOW_TIMEOUT_MS,
        waitingFor: `the window to show ${title}`,
      });
    }

    it("finds a GTK control and clicks it through a resolved target", async () => {
      const fixture = await provision();
      const { computer, context } = fixture;
      await launch(fixture, "thunar /home/rakazo");
      expect([...(await windowTitles(fixture))]).toContain("rakazo - Thunar");

      const found = await pollUntil(
        async () => {
          const result = await sandbox.findElements!(
            computer,
            { text: "Open Parent", app: "thunar" },
            context,
          );
          return result.unknown || result.elements.length === 0 ? null : result;
        },
        {
          intervalMs: 500,
          timeoutMs: WINDOW_TIMEOUT_MS,
          waitingFor: "thunar to publish Open Parent",
        },
      );
      const parent = found.elements[0]!;
      expect(parent.source).toBe("ax");
      expect(parent.role?.toLowerCase()).toContain("button");
      expect(parent.window).toBe("rakazo - Thunar");
      expect(parent.windowFrame).toBeDefined();
      // The element sits inside the window it was read from.
      expect(parent.point.x).toBeGreaterThanOrEqual(parent.windowFrame!.x);
      expect(parent.point.y).toBeGreaterThanOrEqual(parent.windowFrame!.y);
      expect(parent.point.x).toBeLessThanOrEqual(parent.windowFrame!.x + parent.windowFrame!.w);
      expect(parent.point.y).toBeLessThanOrEqual(parent.windowFrame!.y + parent.windowFrame!.h);

      const actions = await resolveComputerTargets(
        [
          {
            kind: "pointer",
            x: parent.point.x,
            y: parent.point.y,
            type: "click",
            target: parent,
          },
        ],
        undefined,
        { find: (request) => sandbox.findElements!(computer, request, context) },
      );
      const result = await sandbox.act(computer, { actions, observe: true }, context);
      expect(result.completed).toBe(1);
      expect(result.observation?.image.byteLength).toBeGreaterThan(0);
      // Going up one folder is what the click was for, and the window names the folder it shows.
      expect(await waitForWindowNamed(fixture, "home - Thunar")).toBe(true);
    }, 300_000);

    it("reports unknown when the perception helper is gone, and still clicks coordinates", async () => {
      const fixture = await provision();
      const { computer, context } = fixture;
      await launch(fixture, "thunar /home/rakazo");
      await windowTitles(fixture);

      // The bracket keeps the pattern from matching this shell's own command line.
      await shell(fixture, "pkill -f '[/]usr/local/bin/atspi.py'");
      const missing = await sandbox.findElements!(computer, { text: "Open Parent" }, context);
      expect(missing).toStrictEqual({ elements: [], truncated: false, unknown: true });
      // A computer without semantic perception keeps working through coordinates.
      const clicked = await sandbox.act(
        computer,
        { actions: [{ kind: "pointer", x: 640, y: 400, type: "click" }] },
        context,
      );
      expect(clicked.completed).toBe(1);
    }, 300_000);

    it("keeps each computer's windows on its own display", async () => {
      const first = await provision();
      const second = await provision();
      await shell(first, "mkdir -p /home/rakazo/first");
      await shell(second, "mkdir -p /home/rakazo/second");
      await launch(first, "thunar /home/rakazo/first");
      await launch(second, "thunar /home/rakazo/second");

      const [firstTitles, secondTitles] = await Promise.all([
        windowTitles(first),
        windowTitles(second),
      ]);
      expect([...firstTitles]).toContain("first - Thunar");
      expect([...firstTitles]).not.toContain("second - Thunar");
      expect([...secondTitles]).toContain("second - Thunar");
      expect([...secondTitles]).not.toContain("first - Thunar");
    }, 300_000);
  },
);
