import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import type { PublicTask } from "@rakazo/contracts";
import type { Client } from "./client.js";
import { ApiError, createClient } from "./client.js";
import { loadConfig, saveConfig } from "./config.js";

const USAGE = `Usage: rakazo <command>

  login [--url <server>] [--key <api key>]   Save the server and API key
  bots                                       List the bots you can use
  chat <bot> <message>                       Send a message and print the reply as it arrives
  task create <bot> <message> [--wait] [--callback <https url>]
  task get <task id>
  task wait <task id>                        Wait until the task finishes or asks something
  task send <task id> <message> [--wait]

<bot> is a bot's id or exact name. RAKAZO_URL and RAKAZO_API_KEY override saved login.
`;

function printTask(task: PublicTask, json: boolean) {
  if (json) {
    stdout.write(`${JSON.stringify(task, null, 2)}\n`);
    return;
  }
  stdout.write(`${task.id}  ${task.status}\n`);
  if (task.output) stdout.write(`\n${task.output}\n`);
  if (task.question) stdout.write(`\n${task.question}\n`);
}

async function waitFor(client: Client, task: PublicTask): Promise<PublicTask> {
  let last = task;
  for await (const next of client.followTask(task.id)) last = next;
  return last;
}

async function ask(question: string): Promise<string> {
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    return (await prompt.question(question)).trim();
  } finally {
    prompt.close();
  }
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      url: { type: "string" },
      key: { type: "string" },
      wait: { type: "boolean", default: false },
      callback: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, ...rest] = positionals;
  if (!command || values.help) {
    stdout.write(USAGE);
    return command || values.help ? 0 : 1;
  }

  if (command === "login") {
    const url = values.url ?? (await ask("Rakazo URL: "));
    const key = values.key ?? (await ask("API key: "));
    if (!url || !key) throw new Error("Both a URL and an API key are needed");
    const config = { url: url.replace(/\/+$/, ""), key };
    const bots = await createClient(config).bots();
    const file = await saveConfig(config);
    stdout.write(
      `Saved to ${file}. ${bots.length} bot${bots.length === 1 ? "" : "s"} available.\n`,
    );
    return 0;
  }

  const config = await loadConfig();
  if (!config) throw new Error("Run `rakazo login` or set RAKAZO_URL and RAKAZO_API_KEY");
  const client = createClient(config);
  const [sub, first, ...words] = rest;

  if (command === "bots") {
    const bots = await client.bots();
    if (values.json) stdout.write(`${JSON.stringify(bots, null, 2)}\n`);
    else for (const bot of bots) stdout.write(`${bot.id}  ${bot.name}  (${bot.owned_by})\n`);
    return 0;
  }
  if (command === "chat") {
    const [bot, ...message] = rest;
    if (!bot || message.length === 0) throw new Error("Usage: rakazo chat <bot> <message>");
    for await (const text of client.chat(bot, message.join(" "))) stdout.write(text);
    stdout.write("\n");
    return 0;
  }
  if (command === "task") {
    if (sub === "create" && first && words.length) {
      let task = await client.createTask({
        bot: first,
        input: words.join(" "),
        callback_url: values.callback,
      });
      if (task.callback_secret && !values.json)
        stdout.write(`Callback secret: ${task.callback_secret}\n`);
      if (values.wait) task = await waitFor(client, task);
      printTask(task, values.json);
      return task.status === "failed" ? 1 : 0;
    }
    if (sub === "get" && first) {
      printTask(await client.task(first), values.json);
      return 0;
    }
    if (sub === "wait" && first) {
      const task = await waitFor(client, await client.task(first));
      printTask(task, values.json);
      return task.status === "failed" ? 1 : 0;
    }
    if (sub === "send" && first && words.length) {
      let task = await client.sendToTask(first, words.join(" "));
      if (values.wait) task = await waitFor(client, task);
      printTask(task, values.json);
      return 0;
    }
  }
  stdout.write(USAGE);
  return 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const message =
      error instanceof ApiError
        ? `${error.message} (${error.status})`
        : error instanceof Error
          ? error.message
          : String(error);
    process.stderr.write(`rakazo: ${message}\n`);
    process.exitCode = 1;
  },
);
