import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runTrial } from "../evals/runner.js";
import type { ModelEmulatorStep } from "../model-emulator.js";
import { startModelEmulator } from "../model-emulator.js";

const databaseAvailable = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

const write = (id: string, file: string) => ({
  id,
  name: "write_file",
  arguments: { path: `notes/${file}.txt`, content: file },
});

/** Each turn: the model calls it answers with, in order. A call list of several is one parallel step. */
const TURNS: Array<{ ask: string; steps: Array<ReturnType<typeof write>[] | string> }> = [
  { ask: "Say hello.", steps: ["Hello."] },
  {
    ask: "Save a, then b, then c, one at a time.",
    steps: [[write("seq-a", "a")], [write("seq-b", "b")], [write("seq-c", "c")], "Saved a, b, c."],
  },
  {
    ask: "Save d and e together.",
    steps: [[write("par-d", "d"), write("par-e", "e")], "Saved d and e."],
  },
  { ask: "Thanks.", steps: ["Any time."] },
];

describe.skipIf(!databaseAvailable)("prompt cache prefix across turns", () => {
  it("starts each turn's request with the previous turn's last request and its reply", async () => {
    const fixtureKey = "offline-cache-prefix-key";
    const turnOfRequest: number[] = [];
    const steps: ModelEmulatorStep[] = TURNS.flatMap((turn, turnIndex) =>
      turn.steps.map(
        (step): ModelEmulatorStep => ({
          expect() {
            turnOfRequest.push(turnIndex);
          },
          response:
            typeof step === "string"
              ? { type: "text", text: step }
              : step.length === 1
                ? { type: "tool", ...step[0]! }
                : { type: "tools", calls: step },
        }),
      ),
    );
    const model = await startModelEmulator({ apiKey: fixtureKey, steps });
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-cache-prefix-"));
    try {
      // Loaded only when the suite runs against a database, as the other Postgres journeys do.
      const { createApp } = await import("@rakazo/api/app");
      const result = await runTrial(
        {
          id: "cache-prefix-fixture",
          purpose: "Each new turn extends the request the previous turn ended with.",
          steps: TURNS.map(({ ask }) => ({ ask })),
          grade: () => [],
        },
        1,
        {
          connection: {
            provider: model.model.provider,
            modelId: model.model.id,
            baseUrl: model.baseUrl,
            apiKey: fixtureKey,
            contextWindow: 160_000,
            maxTokens: 4096,
          },
          timeoutMs: 30_000,
          maxToolCalls: 10,
          createApp: (composio) =>
            createApp({
              databaseUrl: process.env.DATABASE_URL!,
              realtimeDatabaseUrl: process.env.DATABASE_URL!,
              authUrl: "http://127.0.0.1:5173",
              webOrigin: "http://127.0.0.1:5173",
              dataDir,
              sandboxProvider: "fake",
              agentRuntime: "pi",
              wakeupDriver: "memory",
              signupsEnabled: "true",
              composio,
              encryptionKey: "offline-cache-prefix-encryption-key",
            }),
        },
      );
      model.assertComplete();
      expect(result.trace.map((step) => step.status)).toEqual(TURNS.map(() => "completed"));
      const requests = model.requests;
      for (let turn = 1; turn < TURNS.length; turn += 1) {
        const last = requests[turnOfRequest.lastIndexOf(turn - 1)]!;
        const next = requests[turnOfRequest.indexOf(turn)]!;
        expect(next.tools, `tools of turn ${turn}`).toEqual(last.tools);
        expect(
          next.messages.slice(0, last.messages.length),
          `turn ${turn} starts with turn ${turn - 1}'s last request`,
        ).toEqual(last.messages);
        const reply = next.messages[last.messages.length];
        expect(reply?.role).toBe("assistant");
        expect(JSON.stringify(reply?.content)).toContain(
          JSON.stringify(TURNS[turn - 1]!.steps.at(-1)).slice(1, -1),
        );
      }
    } finally {
      await model.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 60_000);
});
