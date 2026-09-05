import { describe, expect, it } from "vitest";
import {
  ComputerScreenUnavailableError,
  isComputerScreenUnavailable,
  SingleScreenClaimTracker,
  withComputerScreenAvailability,
} from "./computer-screens.js";
import { ManagedSandboxEmulator } from "./e2b-emulator.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";

const writer = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  botId: "writer",
  signal: new AbortController().signal,
};
const researcher = { ...writer, botId: "researcher" };

describe("Team Computer parallel screens", () => {
  it("gives fake Team bots distinct observations without ComputerBusyError", async () => {
    const fake = new FakeSandboxProvider();
    expect(fake.describe().capabilities.multiScreen).toBe(true);
    const computer = await fake.provision({ botId: "team-home", homePath: "/tmp/team" }, writer);

    await fake.act(
      computer,
      { actions: [{ kind: "clipboard", text: "writer-desk" }], observe: false },
      writer,
    );
    await fake.act(
      computer,
      { actions: [{ kind: "clipboard", text: "researcher-desk" }], observe: false },
      researcher,
    );

    const [writerScreen, researcherScreen] = await Promise.all([
      fake.observe(computer, writer),
      fake.observe(computer, researcher),
    ]);
    expect(writerScreen.activeWindow?.title).toBe("writer-desk");
    expect(researcherScreen.activeWindow?.title).toBe("researcher-desk");

    const writerView = await fake.connectScreen(computer, { view: "stream" }, writer);
    const researcherView = await fake.connectScreen(computer, { view: "stream" }, researcher);
    expect(writerView.url).toBe("fake://screen/fake-team-home/writer");
    expect(researcherView.url).toBe("fake://screen/fake-team-home/researcher");
    expect(writerView.url).not.toBe(researcherView.url);

    await fake.writeFile(
      computer,
      { path: "shared/note.txt", content: new TextEncoder().encode("office") },
      writer,
    );
    expect(
      new TextDecoder().decode(await fake.readFile(computer, "shared/note.txt", researcher)),
    ).toBe("office");
  });

  it("releases a single-screen claim only for the owning bot", () => {
    const claims = new SingleScreenClaimTracker();
    claims.claim("computer-1", writer);
    claims.release("computer-1", researcher);
    expect(() => claims.claim("computer-1", researcher)).toThrow(ComputerScreenUnavailableError);
    claims.release("computer-1", writer);
    expect(() => claims.claim("computer-1", researcher)).not.toThrow();
  });

  it("does not let stale cleanup release a replacement claim for the same bot", () => {
    const claims = new SingleScreenClaimTracker();
    const oldRun = { ...writer, screenLeaseId: "run-1:1" };
    const newRun = { ...writer, screenLeaseId: "run-2:2" };
    claims.claim("computer-1", oldRun);
    claims.claim("computer-1", newRun);

    expect(claims.release("computer-1", oldRun)).toBe(false);
    expect(() => claims.claim("computer-1", researcher)).toThrow(ComputerScreenUnavailableError);

    expect(claims.release("computer-1", newRun)).toBe(true);
    expect(() => claims.claim("computer-1", researcher)).not.toThrow();
  });

  it("releases a claim retained across a same-run takeover resume", () => {
    const claims = new SingleScreenClaimTracker();
    const paused = { ...writer, screenLeaseId: "run-1:1" };
    const resumed = { ...writer, screenLeaseId: "run-1:8" };
    claims.claim("computer-1", paused);
    claims.release("computer-1", resumed);
    expect(() => claims.claim("computer-1", researcher)).not.toThrow();
  });

  it("rejects a delayed claim after a newer run reclaimed the screen", () => {
    const claims = new SingleScreenClaimTracker();
    claims.claim("computer-1", { ...writer, screenLeaseId: "run-2:2" });
    expect(() => claims.claim("computer-1", { ...writer, screenLeaseId: "run-1:1" })).toThrow(
      ComputerScreenUnavailableError,
    );
    claims.release("computer-1", { ...writer, screenLeaseId: "run-1:1" });
    expect(() => claims.claim("computer-1", researcher)).toThrow(ComputerScreenUnavailableError);
    claims.release("computer-1", { ...writer, screenLeaseId: "run-2:2" });
    expect(() => claims.claim("computer-1", researcher)).not.toThrow();
  });

  it("turns a graphical refusal into a tool error object", async () => {
    const claims = new SingleScreenClaimTracker();
    claims.claim("computer-1", writer);
    await expect(
      withComputerScreenAvailability(async () => {
        claims.claim("computer-1", researcher);
        return "ok";
      }),
    ).resolves.toEqual({ error: expect.stringMatching(/temporarily busy/) });
    expect(isComputerScreenUnavailable(new Error("cannot allocate another screen"))).toBe(true);
  });

  it("lets a second Team bot use graphics after the first run releases the claim", async () => {
    const emulator = new ManagedSandboxEmulator();
    expect(emulator.describe().capabilities.multiScreen).toBe(false);
    const computer = await emulator.provision({ botId: "team-home", homePath: "/tmp" }, writer);
    await emulator.observe(computer, writer);
    await emulator.connectScreen(computer, { view: "stream" }, researcher);
    await expect(emulator.observe(computer, writer)).resolves.toMatchObject({
      activeWindow: expect.anything(),
    });
    await expect(emulator.observe(computer, researcher)).rejects.toThrow(
      ComputerScreenUnavailableError,
    );
    await emulator.releaseScreen(computer, writer);
    await expect(emulator.observe(computer, researcher)).resolves.toMatchObject({
      activeWindow: expect.anything(),
    });
  });

  it("refuses a second graphical session on single-screen providers", () => {
    const claims = new SingleScreenClaimTracker();
    claims.claim("computer-1", writer);
    expect(() => claims.claim("computer-1", researcher)).toThrow(ComputerScreenUnavailableError);
    claims.claim("computer-1", writer);
    claims.release("computer-1");
    expect(() => claims.claim("computer-1", researcher)).not.toThrow();
  });
});
