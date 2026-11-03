import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { HostScreen } from "@rakazo/adapters/host-screen";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDesktopHostScreen,
  SCREEN_DRIVER_RELEASES,
  screenDriverInstaller,
} from "./host-screen.js";

const scope = { botId: "bot-1", signal: new AbortController().signal };

// Downloads the pinned driver and drives a real app, so it runs only on CI's Windows runner.
describe.runIf(process.platform === "win32" && process.env.CI)("Windows screen control", () => {
  let dir: string;
  let screen: HostScreen;
  let notepad: ReturnType<typeof spawn>;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "rakazo-screen-"));
    screen = createDesktopHostScreen({
      platform: "win32",
      driver: screenDriverInstaller({
        dir: path.join(dir, "bin"),
        fetch: (url) => fetch(url),
        release: SCREEN_DRIVER_RELEASES.win32,
      }),
      home: path.join(dir, "home"),
      permissions: {
        isTrustedAccessibilityClient: () => false,
        getMediaAccessStatus: () => "denied",
        requestScreenCapture: async () => [],
      },
      locked: () => false,
    })!;
    notepad = spawn("notepad.exe", { detached: true, stdio: "ignore" });
    await sleep(3_000);
  }, 120_000);

  afterAll(async () => {
    await screen?.close();
    notepad?.kill();
    await sleep(500);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("observes Notepad, writes into it in the background, and reads the text back", async () => {
    const before = await screen.observe(scope, "notepad");
    console.log(before.tree);
    expect(before.image?.mimeType).toBe("image/png");
    const editor = /\[(\d+)\] (?:textfield|document)/.exec(before.tree);
    expect(editor, before.tree).not.toBeNull();
    const written = await screen.act(scope, "notepad", [
      { kind: "set", element: Number(editor![1]), value: "Hello from Rakazo" },
    ]);
    console.log(JSON.stringify({ ...written, observation: written.observation?.tree }));
    expect(written).toMatchObject({ completed: 1 });
    expect(written.observation?.tree).toContain("Hello from Rakazo");
    const selected = await screen.act(scope, "notepad", [
      { kind: "menu", path: ["Edit", "Select All"] },
    ]);
    console.log(JSON.stringify({ completed: selected.completed, error: selected.error }));
    expect(selected).toMatchObject({ completed: 1 });
    expect(selected.error).toBeUndefined();
    await expect(screen.observe(scope, "rakazo-missing-app")).rejects.toThrow(
      'No app named "rakazo-missing-app" is open.',
    );
  }, 120_000);
});
