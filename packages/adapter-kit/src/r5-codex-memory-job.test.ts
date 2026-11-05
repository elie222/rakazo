import { describe, expect, it } from "vitest";
import {
  MEMORY_CAPTURE_MAX_ATTEMPTS,
  memoryCaptureJob,
  memoryCaptureJobKey,
  parseBackgroundJob,
} from "./background-jobs.js";

describe("R5 memory capture queue contract", () => {
  it("keeps a pending job with exactly six attempts and a run-scoped key", () => {
    // Literal expectations catch a changed constant or key helper, unlike self-referential fixtures.
    expect(MEMORY_CAPTURE_MAX_ATTEMPTS).toBe(6);
    expect(memoryCaptureJobKey("r5-run")).toBe("memory.capture:r5-run");
    expect(memoryCaptureJob("r5-run")).toEqual({
      name: "memory.capture",
      payload: { runId: "r5-run" },
      replaceKey: "memory.capture:r5-run",
      keepExisting: true,
      maxAttempts: 6,
    });
    expect(memoryCaptureJob("r5-run")).toEqual(memoryCaptureJob("r5-run"));
  });

  it("preserves distinct run identities in both keys and parsed payloads", () => {
    const runIds = ["run-1", "run-11", "run:1", "run/1"];
    const jobs = runIds.map(memoryCaptureJob);
    expect(new Set(jobs.map((job) => job.replaceKey)).size).toBe(runIds.length);
    for (const [index, job] of jobs.entries()) {
      expect(parseBackgroundJob(job.name, job.payload)).toEqual({
        name: "memory.capture",
        payload: { runId: runIds[index] },
      });
    }
  });

  it.each([
    ["missing payload", undefined],
    ["null payload", null],
    ["array payload", []],
    ["missing runId", {}],
    ["null runId", { runId: null }],
    ["numeric runId", { runId: 42 }],
    ["array runId", { runId: ["r5-run"] }],
    ["empty runId", { runId: "" }],
  ])("rejects %s at the queue boundary", (_label, payload) => {
    expect(() => parseBackgroundJob("memory.capture", payload)).toThrow();
  });

  it("carries only the run identity through schema parsing", () => {
    expect(
      parseBackgroundJob("memory.capture", {
        runId: "r5-run",
        scope: "shared",
        capture: { answer: "untrusted queued copy" },
        maxAttempts: 99,
      }),
    ).toEqual({ name: "memory.capture", payload: { runId: "r5-run" } });
  });
});
