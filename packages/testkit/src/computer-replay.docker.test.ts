import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { serve } from "@hono/node-server";
import type { ComputerRef } from "@rakazo/adapter-kit";
import { ComputerBrowserProvider, DockerSandboxProvider } from "@rakazo/adapters";
import { describe, expect, it } from "vitest";
import { computerReplayContext, runComputerReplay, waitForReplayFile } from "./computer-replay.js";
import {
  CONTACTS_CSV,
  CONTACTS_PATH,
  EXPORT_RECEIPT_PATH,
  installContactsFixture,
} from "./computer-replay-fixture.js";

describe.skipIf(process.env.RUN_COMPUTER_REPLAY_DOCKER !== "1")(
  "computer replay with real Docker Chrome and emulated model",
  () => {
    it("downloads a CSV through real page actions and captures an actual screenshot", async () => {
      if (!process.env.DATA_DIR || !process.env.SANDBOX_SUPERVISOR_TOKEN) {
        throw new Error(
          "Run through the computer-replay CLI to create an isolated supervisor environment",
        );
      }
      const { supervisorApp } = await import("../../../infra/sandboxes/supervisor/src/index.js");
      const server = serve({ fetch: supervisorApp.fetch, hostname: "127.0.0.1", port: 0 });
      try {
        if (!server.listening)
          await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.once("listening", () => {
              server.off("error", reject);
              resolve();
            });
          });
        const port = (server.address() as AddressInfo).port;
        const sandbox = new DockerSandboxProvider(
          `http://127.0.0.1:${port}`,
          process.env.SANDBOX_SUPERVISOR_TOKEN,
        );
        const context = {
          ...computerReplayContext(),
          botId: `replay-${randomUUID()}`,
          signal: AbortSignal.timeout(240_000),
        };
        const homePath = path.join(process.env.DATA_DIR, "homes", context.botId);
        await mkdir(homePath, { recursive: true });
        let computer: ComputerRef | undefined;
        let ownedNetwork: string | undefined;
        try {
          // Optional escape hatch for a daemon whose automatic address pool is full.
          // Docker rejects overlapping subnets; only this test's unique network is touched.
          if (process.env.COMPUTER_REPLAY_SUBNET) {
            const { computerNetworkNameFor } = await import(
              "../../../infra/sandboxes/supervisor/src/computer-spec.js"
            );
            const name = computerNetworkNameFor(context.botId);
            execFileSync(
              "docker",
              ["network", "create", "--subnet", process.env.COMPUTER_REPLAY_SUBNET, name],
              { stdio: "pipe" },
            );
            ownedNetwork = name;
          }
          computer = await sandbox.provision({ botId: context.botId, homePath }, context);
          await sandbox.prepare(computer, context);
          await installContactsFixture(sandbox, computer, context);
          const result = await runComputerReplay(
            sandbox,
            new ComputerBrowserProvider({ sandbox }),
            computer,
            context,
          );
          expect(result.modelRequests).toBe(9);
          // These reads are independent of the agent's reply and tool-result assertions.
          expect(await waitForReplayFile(sandbox, computer, context, CONTACTS_PATH)).toBe(
            CONTACTS_CSV,
          );
          expect(await waitForReplayFile(sandbox, computer, context, EXPORT_RECEIPT_PATH)).toBe(
            "1",
          );
          const files = await sandbox.listFiles(computer, "Downloads", context);
          expect(files.filter((file) => file.path.endsWith(".csv"))).toHaveLength(1);
        } finally {
          try {
            if (computer)
              await sandbox.destroy(computer, { ...context, signal: AbortSignal.timeout(30_000) });
          } finally {
            if (ownedNetwork) {
              // Successful destroy already removes it. A failed provision may leave it behind.
              execFileSync("docker", ["network", "rm", "--force", ownedNetwork], {
                stdio: "pipe",
                timeout: 30_000,
              });
            }
          }
        }
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) =>
            error && (!("code" in error) || error.code !== "ERR_SERVER_NOT_RUNNING")
              ? reject(error)
              : resolve(),
          );
          server.closeAllConnections();
        });
      }
    }, 300_000);
  },
);
