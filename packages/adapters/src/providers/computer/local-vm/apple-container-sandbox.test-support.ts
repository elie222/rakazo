import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AppleContainerSandboxProvider } from "./apple-container-sandbox.js";

// A stand-in for the `container` CLI: it logs each call and keeps its VMs in a JSON file.
const FAKE_CLI = `
const fs = require("node:fs");
const dir = __dirname;
const statePath = dir + "/state.json";
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const argv = process.argv.slice(2);
const log = (stdin) => fs.appendFileSync(dir + "/calls.jsonl", JSON.stringify({ argv, stdin }) + "\\n");
const readStdin = () => { try { return fs.readFileSync(0, "utf8"); } catch { return ""; } };
const option = (name) => argv[argv.indexOf(name) + 1];
const [command, sub] = argv;
if (command === "exec") {
  let index = 1;
  while (argv[index].startsWith("-")) index += ["--interactive", "--tty"].includes(argv[index]) ? 1 : 2;
  const [name, program, ...rest] = argv.slice(index);
  const stdin = argv.includes("--interactive") ? readStdin() : "";
  log(stdin);
  if (state.vms[name]?.status.state !== "running") { process.stderr.write("not running"); process.exit(1); }
  if (program === "nft") {
    if (state.nftMissing) { process.stderr.write("exec failed: nft: not found"); process.exit(127); }
    if (rest[0] === "list") process.stdout.write("table inet rakazo {}\\n");
    process.exit(0);
  }
  // The tool follows setpriv's "--" and the four words of the timeout wrapper.
  const tool = rest.slice(rest.indexOf("--") + 1);
  if (tool[0] === "timeout") tool.splice(0, 4);
  const file = state.files[tool.at(-1)];
  if (file !== undefined && tool[0] === "stat") { process.stdout.write(String(Buffer.from(file, "base64").length)); process.exit(0); }
  if (file !== undefined && tool[0] === "cat") { process.stdout.write(Buffer.from(file, "base64")); process.exit(0); }
  const execAt = rest.indexOf("rakazo-exec");
  const requested = execAt >= 0 ? rest.slice(rest.indexOf("timeout", execAt) + 4) : [];
  if (requested[0] === "echo") { process.stdout.write(requested.slice(1).join(" ") + "\\n"); process.exit(0); }
  const script = rest.join(" ");
  if (script.includes("mkdir -p -- '/home/rakazo'")) process.exit(0);
  if (script.includes("/dev/tcp/127.0.0.1/6080") || script.includes("rakazo-write")) process.exit(0);
  if (script.includes("sleep")) setInterval(() => {}, 1000);
  else { process.stdout.write("out:" + script.slice(-5)); process.stderr.write("err"); process.exit(7); }
} else {
  log();
  if (command === "network") process.exit(0);
  if (command === "run") {
    const name = option("--name");
    state.vms[name] = {
      configuration: { id: name, labels: { "rakazo.bot-id": option("--label").split("=")[1] } },
      status: { state: "running", networks: [{ ipv4Address: "192.168.70.2/24", ipv4Gateway: "192.168.70.1" }] },
    };
    save();
  } else if (command === "inspect") {
    if (sub === "rakazo-unreadable") { process.stderr.write("Error: XPC connection interrupted"); process.exit(1); }
    if (!state.vms[sub]) { process.stderr.write("Error: container not found: " + sub); process.exit(1); }
    process.stdout.write(JSON.stringify([state.vms[sub]]));
  } else if (command === "ls") {
    process.stdout.write(JSON.stringify(Object.values(state.vms)));
  } else if (command === "rm") {
    delete state.vms[argv[2]];
    save();
  }
}
`;

const fakes: string[] = [];

export function removeFakeClis() {
  for (const dir of fakes.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function fakeCli(
  vms: Record<string, { botId: string; state?: string }> = {},
  nftMissing = false,
  files: Record<string, Uint8Array> = {},
) {
  const dir = mkdtempSync(path.join(tmpdir(), "rakazo-fake-container-"));
  fakes.push(dir);
  const cli = path.join(dir, "container");
  writeFileSync(cli, `#!/usr/bin/env node\n${FAKE_CLI}`);
  chmodSync(cli, 0o755);
  const records = Object.fromEntries(
    Object.entries(vms).map(([name, vm]) => [
      name,
      {
        configuration: { id: name, labels: { "rakazo.bot-id": vm.botId } },
        status: {
          state: vm.state ?? "running",
          networks: [{ ipv4Address: "192.168.70.2/24", ipv4Gateway: "192.168.70.1" }],
        },
      },
    ]),
  );
  writeFileSync(
    path.join(dir, "state.json"),
    JSON.stringify({
      vms: records,
      nftMissing,
      files: Object.fromEntries(
        Object.entries(files).map(([name, content]) => [
          name,
          Buffer.from(content).toString("base64"),
        ]),
      ),
    }),
  );
  return {
    provider: new AppleContainerSandboxProvider({
      cli,
      computerImage: "computer:test",
      readyTimeoutMs: 5_000,
    }),
    calls: (): { argv: string[]; stdin?: string }[] => {
      try {
        return readFileSync(path.join(dir, "calls.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
    vms: (): Record<string, unknown> =>
      JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8")).vms,
  };
}
