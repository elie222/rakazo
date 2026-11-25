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

function printTask(task: PublicTask & { callback_secret?: string }, json: boolean) {
  if (json) {
    stdout.write(`${JSON.stringify(task, null, 2)}\n`);
    return;
  }
  stdout.write(`${task.id}  ${task.status}\n`);
  if (task.output) stdout.write(`\n${task.output}\n`);
  if (task.question) stdout.write(`\n${task.question}\n`);
}

/** A task that stopped without finishing, which a script should see as a failure. */
const ended = (task: PublicTask) => task.status === "failed" || task.status === "cancelled";

/** Follows a task until it settles, reconnecting when a stream ends early. */
async function waitFor(client: Client, task: PublicTask): Promise<PublicTask> {
  let last = task;
  for (let quiet = 0; last.status === "working"; ) {
    const before = last.updated_at;
    for await (const next of client.followTask(task.id)) last = next;
    quiet = last.updated_at === before ? quiet + 1 : 0;
    if (last.status === "working" && quiet >= 3)
      throw new Error(`Lost the connection while task ${task.id} was still working`);
  }
  return last;
}

/** Reads one line; with `hidden`, what is typed is not echoed, as for a password. */
async function ask(question: string, hidden = false): Promise<string> {
  const prompt = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY });
  if (hidden) {
    stdout.write(question);
    const echo = (prompt as unknown as { _writeToOutput: (text: string) => void })._writeToOutput;
    (prompt as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = (text) => {
      if (text.includes("\n")) echo.call(prompt, "\n");
    };
  }
  try {
    return (await prompt.question(hidden ? "" : question)).trim();
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
    const key = values.key ?? (await ask("API key: ", true));
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
    else for (const bot of bots) stdout.write(`${bot.name}  (${bot.owned_by})  ${bot.id}\n`);
    return 0;
  }
  if (command === "chat") {
    const [bot, ...message] = rest;
    if (!bot || message.length === 0) throw new Error("Usage: rakazo chat <bot> <message>");
    let reply = "";
    for await (const text of client.chat(bot, message.join(" "))) {
      // JSON output waits for the whole reply, so a script reads one object.
      if (values.json) reply += text;
      else stdout.write(text);
    }
    stdout.write(values.json ? `${JSON.stringify({ reply })}\n` : "\n");
    return 0;
  }
  if (command === "task") {
    if (sub === "create" && first && words.length) {
      const created = await client.createTask({
        bot: first,
        input: words.join(" "),
        callback_url: values.callback,
      });
      const { callback_secret: secret } = created;
      // The secret is only ever sent now, so it is printed whatever else is asked for.
      if (secret && !values.json) stdout.write(`Callback secret: ${secret}\n`);
      const task = values.wait ? await waitFor(client, created) : created;
      printTask(secret ? { ...task, callback_secret: secret } : task, values.json);
      return ended(task) ? 1 : 0;
    }
    if (sub === "get" && first) {
      printTask(await client.task(first), values.json);
      return 0;
    }
    if (sub === "wait" && first) {
      const task = await waitFor(client, await client.task(first));
      printTask(task, values.json);
      return ended(task) ? 1 : 0;
    }
    if (sub === "send" && first && words.length) {
      let task = await client.sendToTask(first, words.join(" "));
      if (values.wait) task = await waitFor(client, task);
      printTask(task, values.json);
      return ended(task) ? 1 : 0;
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
