import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const outDir = join(repoRoot, "apps/www/public/graphics/chat");
const chrome = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";
const port = 5173;
const shots = [
  ["create", "create-bot.png"],
  ["approval", "approval.png"],
  ["model", "model.png"],
  ["routine", "routine.png"],
];

mkdirSync(outDir, { recursive: true });

const server = spawn("pnpm", ["--filter", "@rakazo/web", "exec", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
  cwd: repoRoot,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env },
});

function waitForServer() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("vite did not start")), 90_000);
    const onData = (chunk) => {
      const text = String(chunk);
      if (text.includes("Local:") || text.includes("ready")) {
        clearTimeout(timer);
        resolve();
      }
    };
    server.stdout.on("data", onData);
    server.stderr.on("data", onData);
    server.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`vite exited ${code}`));
    });
  });
}

try {
  await waitForServer();
  await new Promise((resolve) => setTimeout(resolve, 500));
  for (const [view, file] of shots) {
    const target = join(outDir, file);
    const url = `http://127.0.0.1:${port}/e2e/fixtures/marketing-shots.html?view=${view}`;
    const result = spawnSync(
      chrome,
      [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--force-device-scale-factor=1",
        "--window-size=1200,800",
        "--virtual-time-budget=8000",
        "--default-background-color=00000000",
        `--screenshot=${target}`,
        url,
      ],
      { stdio: "inherit" },
    );
    if (result.status !== 0) {
      throw new Error(`Chrome capture failed with status ${result.status ?? 1}`);
    }
    console.log(file);
  }
} finally {
  server.kill("SIGTERM");
}
