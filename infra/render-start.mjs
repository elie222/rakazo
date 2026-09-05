import { spawn } from "node:child_process";

process.env.GIT_SHA = process.env.RENDER_GIT_COMMIT ?? process.env.GIT_SHA;

// One Render service can host both long-lived processes for a small deployment.
// The same worker entrypoint can also run as an independent Render worker.
const children = [
  spawn("pnpm", ["--filter", "@rakazo/api", "start"], {
    stdio: "inherit",
    env: { ...process.env, API_HOST: "0.0.0.0", API_PORT: process.env.PORT ?? "3100" },
  }),
  spawn("pnpm", ["--filter", "@rakazo/worker", "start"], { stdio: "inherit", env: process.env }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  const deadline = setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
    process.exit(code);
  }, 20000);
  Promise.all(
    children.map((child) =>
      child.exitCode !== null
        ? Promise.resolve()
        : new Promise((resolve) => child.once("exit", resolve)),
    ),
  ).then(() => {
    clearTimeout(deadline);
    process.exit(code);
  });
}
for (const child of children) {
  child.once("error", () => stop(1));
  child.once("exit", (code) => stop(code ?? 1));
}
process.once("SIGTERM", () => stop());
process.once("SIGINT", () => stop());
