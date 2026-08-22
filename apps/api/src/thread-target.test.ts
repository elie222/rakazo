import { runContinueJob } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";

function fanoutRunClientNonce(
  clientNonce: string | undefined,
  botId: string,
  multiTarget: boolean,
): string | undefined {
  if (!clientNonce) return undefined;
  return multiTarget ? `${clientNonce}:${botId}` : clientNonce;
}

function sendNonceKeys(clientNonce: string, memberBotIds?: string[]): string[] {
  const keys = new Set<string>([clientNonce]);
  if (memberBotIds) {
    for (const botId of memberBotIds) {
      keys.add(`${clientNonce}:${botId}`);
    }
  }
  return [...keys];
}

describe("fanoutRunClientNonce", () => {
  it("uses the request nonce for a single target", () => {
    expect(fanoutRunClientNonce("nonce-1", "bot-a", false)).toBe("nonce-1");
  });

  it("derives per-bot keys for multi-target fan-out", () => {
    expect(fanoutRunClientNonce("nonce-1", "bot-a", true)).toBe("nonce-1:bot-a");
    expect(fanoutRunClientNonce("nonce-1", "bot-b", true)).toBe("nonce-1:bot-b");
  });
});

describe("sendNonceKeys", () => {
  it("uses only the raw nonce for a 1:1 bot send", () => {
    expect(sendNonceKeys("nonce-1")).toEqual(["nonce-1"]);
  });

  it("includes raw nonce and every member key for group threads", () => {
    expect(sendNonceKeys("nonce-1", ["bot-a", "bot-b"])).toEqual([
      "nonce-1",
      "nonce-1:bot-a",
      "nonce-1:bot-b",
    ]);
  });
});

describe("nonce replay enqueue", () => {
  it("re-enqueues only queued runs on replay", async () => {
    const enqueue = vi.fn();
    const runs = [
      { id: "run-a", status: "queued" },
      { id: "run-b", status: "completed" },
      { id: "run-c", status: "waiting_input" },
    ];
    for (const run of runs) {
      if (run.status === "queued") {
        await enqueue(runContinueJob(run.id));
      }
    }
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(runContinueJob("run-a"));
  });
});
