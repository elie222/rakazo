# API, MCP and CLI

Hand work to your bots from scripts and other agents. An API key acts as you: it can use the bots
you can use, in every Space you belong to, and nothing else in your account.

The examples use `https://rakazo.example.com` for the address you open Rakazo at. Replace it with
yours.

## API keys

In **Settings**, under **API keys**, choose **Create key** and give it a name. Rakazo asks you to
confirm it's you, then shows the key once. Copy it then: Rakazo keeps only a hash.

Send the key as `Authorization: Bearer <key>`. Delete a key in the same place to stop everything
using it at once. Each key may make 60 requests a minute; past that, the answer is `429` with a
`Retry-After` header.

## How conversations work

Each bot keeps one conversation with you, the same chat you see in the app, with its own memory.
Every request adds a message to that chat and starts the bot's turn the way a message from the app
does, so you can watch and step in from any device. Send only what is new: earlier messages a
client repeats are already in the chat.

A turn that needs you, such as an approval or a question, waits with status `needs_input`. Answer a
question with a follow-up message; approve or decline an action in the app.

## OpenAI-compatible endpoint

Point any OpenAI SDK at `https://rakazo.example.com/api/v1` with your key. Models are your bots:
`GET /models` lists them, and `model` takes a bot's id or its exact name.

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://rakazo.example.com/api/v1",
  apiKey: process.env.RAKAZO_API_KEY,
});

const stream = await client.chat.completions.create({
  model: "Research", // a bot's name or id
  messages: [
    { role: "user", content: "Watch r/LocalLLaMA for new model releases and tell me daily." },
  ],
  stream: true,
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
```

`POST /chat/completions` reads the last `user` message and ignores sampling settings: the bot uses
the model it is set to. Streaming sends each reply as the bot posts it. The response carries an
`x-rakazo-task-id` header, so a long turn can be followed with the task API below. A request that
does not stream returns once the turn settles, or after 15 minutes with what the bot has said so
far, marked `finish_reason: "length"`; the bot keeps working either way. A turn that fails or is cancelled answers with an error, as
the last event of a stream. Token counts are reported as zero.

## Tasks

For long jobs, start a task and come back for the result.

| Request                                                         | Does                                                     |
| --------------------------------------------------------------- | -------------------------------------------------------- |
| `POST /api/v1/tasks` with `{ "bot", "input", "callback_url"? }` | Starts a task                                            |
| `GET /api/v1/tasks/<id>`                                        | Reads it                                                 |
| `GET /api/v1/tasks/<id>/events`                                 | Streams it as server-sent `task` events until it settles |
| `POST /api/v1/tasks/<id>/messages` with `{ "input" }`           | Sends a follow-up, such as an answer                     |

A follow-up to a task that has ended starts a new task. The response is the task the message went
to, so follow its `id`; a callback on the first task reports the new one too.

A task reads:

```json
{
  "id": "…",
  "object": "task",
  "bot_id": "…",
  "status": "working",
  "output": "The bot's replies so far",
  "question": null,
  "error": null,
  "created_at": "…",
  "updated_at": "…"
}
```

`status` is `working`, `needs_input`, `completed`, `failed` or `cancelled`. `question` is what the
bot asked while it needs input.

### Callbacks

With an HTTPS `callback_url`, Rakazo posts `{ "type": "task.settled", "id": "…", "task": { … } }`
there each time the task completes, fails, is cancelled or needs input. `id`, also sent as the
`x-rakazo-delivery` header, names that state and stays the same if a delivery is retried, so drop
one you have already handled. A callback carries at most the newest 65,536 characters of output, with
`"truncated": true` when it was cut; read the task for all of it.

The create response includes a `callback_secret`, shown once. It is the same for every task one
key sends to the same address; a new key gets a new secret. Each callback carries `x-rakazo-signature: t=<unix seconds>,v1=<signature>`,
where the signature is the hex HMAC-SHA256 of `<t>.<raw body>` with that secret. Check it, and
reject an old `t`. A failed delivery is retried with backoff. The address must be public: private
and local addresses are refused.

## MCP server

`https://rakazo.example.com/api/mcp` is a Streamable HTTP MCP server. Add it to an MCP client with
your key as a bearer token. With a client that takes a JSON config:

```json
{
  "mcpServers": {
    "rakazo": {
      "type": "http",
      "url": "https://rakazo.example.com/api/mcp",
      "headers": { "Authorization": "Bearer <your key>" }
    }
  }
}
```

Its tools are `list_bots`, `create_task`, `get_task` and `send_task_message`. The task tools wait up
to `wait_seconds` (60 by default) for the task to settle before they return.

## CLI

The `rakazo` CLI wraps the same API. Build it from a checkout of the repository:

```sh
pnpm install
pnpm --filter @rakazo/cli build
alias rakazo="node $PWD/apps/cli/dist/rakazo.js"
```

```sh
rakazo login --url https://rakazo.example.com   # asks for the key, saves both
rakazo bots
rakazo chat Research "What changed on our pricing page this week?"
rakazo task create Research "Watch for new model releases and report daily" --wait
rakazo task wait <task id>
rakazo task send <task id> "Yes, post it"
```

`RAKAZO_URL` and `RAKAZO_API_KEY` override the saved login. Add `--json` for machine-readable
output.
