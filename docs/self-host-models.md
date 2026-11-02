# Models

Choose the deployment's default model, connect local or OpenAI-compatible servers, and configure
approvals, media generation and voice.

## Deployment model

The deployment model is used by anyone who has not connected a model of their own. `PI_DEFAULT_PROVIDER`
picks the provider and `PI_DEFAULT_MODEL` the model:

| `PI_DEFAULT_PROVIDER` | Key | Default model |
| --- | --- | --- |
| `openrouter` (default) | `OPENROUTER_API_KEY` | `openai/gpt-6-luna` |
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-5` |

Pick a vision-capable model so screenshot computer tools stay available.

A provider that authenticates from the host needs no key: for Amazon Bedrock with an ECS task,
IRSA or EC2 instance role, opt in with `PI_DEFAULT_CREDENTIALS=host` and set
`PI_DEFAULT_PROVIDER=amazon-bedrock`, `PI_DEFAULT_MODEL` and `AWS_REGION`. With an instance
role, keep [restricted computer egress](./self-host-docker-computers.md#restricted-computer-egress) on so bot computers
cannot read the role's credentials from the metadata endpoint.

Google Vertex works the same way with `PI_DEFAULT_PROVIDER=google-vertex`, using the host's
application default credentials (`GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT`,
`GOOGLE_CLOUD_LOCATION`). Runs on host credentials are billed to that cloud account.

The Compose files also pass the standard provider key variables the agent runtime reads itself
(`OPENAI_API_KEY`, `GEMINI_API_KEY`, `MISTRAL_API_KEY`, `GROQ_API_KEY`, `XAI_API_KEY` and others) to
the API and worker, for models that have no stored credential.

`RAKAZO_LIVE_MODEL_CATALOG=off` disables provider and Codex live catalog probing; the default is on.

## Approvals

Approvals have three modes in **Settings → Approvals**: Never ask runs every action, Auto lets an
approval model pass actions that fit the request, and Ask asks before any change. A space starts
in Auto, which asks like Ask until an approval model is available. Each
person can allow or block single tools and sites in every mode, and a space can customize its
approvals apart from the account.

In **Settings → Models → Approval model**, each user can select a model
from an existing connection and add ordered backups, independently of their main model. Personal
connections use their own credentials; hosted calls follow the same Rakazo credit rules as chat.
Backups are tried only when a checker fails. An explicit ask, including an uncertain decision,
still requires a person.

The deployment checker remains the default when no approval model is selected. For OpenRouter
Jev, set `RAKAZO_AUTO_REVIEW_PROVIDER=openrouter` and
`RAKAZO_AUTO_REVIEW_MODEL=typesafe/jev-1.14`; it uses `OPENROUTER_API_KEY` and the Decisions API.
TypeSafe direct remains available through `RAKAZO_AUTO_REVIEW_PROVIDER=jev` and
`TYPESAFE_API_KEY`. Core runs without either hosted service.

With TypeSafe, `RAKAZO_AUTO_REVIEW_MODEL` defaults to `jev-latest`, and
`RAKAZO_AUTO_REVIEW_MIN_CONFIDENCE` (0 to 1, default `0.5`) is the confidence below which Auto asks
the person instead. `RAKAZO_AUTO_REVIEW_TIMEOUT_MS` (200 to 30000, default `10000`) bounds each
check.

## Local models

To use an operator-controlled OpenAI-compatible server such as Ollama, LM Studio, llama.cpp, or
MLX, list its model IDs and an endpoint that both the API and worker processes can reach:

```env
RAKAZO_LOCAL_MODELS=qwen3:4b,llama3.1:8b,qwen3-vl
RAKAZO_LOCAL_MODELS_URL=http://127.0.0.1:11434/v1
RAKAZO_LOCAL_CONTEXT_WINDOW=32768
RAKAZO_LOCAL_MAX_TOKENS=4096
# Optional: model ids on this endpoint that accept images (screenshot computer tools).
RAKAZO_LOCAL_VISION_MODELS=qwen3-vl
```

`RAKAZO_LOCAL_MAX_TOKENS` is the output limit sent with every request to a local model, unless the
connection sets its own max-tokens value. It never exceeds a quarter of
`RAKAZO_LOCAL_CONTEXT_WINDOW`, so the prompt keeps the rest; a higher limit leaves less room for the
prompt, so long chats are compacted sooner.

The loopback default is suitable when running Rakazo from a source checkout. From containers,
prefer a stable LAN RFC1918 address (not Compose service DNS alone). On Docker Desktop,
`host.docker.internal` also works.
On Docker Desktop, a bot computer shell can often reach services bound to host `127.0.0.1`
through that same hostname. Do not run sensitive unauthenticated services on loopback while
bots run, or firewall / block that path. Linux does not get `host.docker.internal` the same
way by default.
Only configure an endpoint you control: prompts, attachments, and tool results sent to that model
leave Rakazo through this URL. Leave `RAKAZO_LOCAL_MODELS` blank to disable the provider.

## Ollama Cloud

In **Settings → Models**, choose **Ollama Cloud**, paste an API key from ollama.com, then **Find models**. This uses an OpenAI-compatible connection with no environment configuration, and stays available when `RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC=0`.

## OpenAI-compatible connections

Each user can also connect their own OpenAI-compatible endpoint from **Connect a model** /
**Settings → Models** on web and mobile. Choose **OpenAI-compatible**, enter the server base URL
(for example `http://127.0.0.1:8000/v1`), the exact model id, and an optional API key.
Add optional request headers under **Advanced**; values are stored encrypted, and only their names
are shown afterwards.
Public hosts and ordinary hostnames need HTTPS when they receive an API key or custom headers,
and must resolve only to public addresses. Set `RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC=0` on the API
and worker to block them.
Literal private IP, loopback, and `host.docker.internal` targets do not, but only the deployment
owner can use them, checked on save, on model discovery, and on every run. Set
`MCP_ALLOW_PRIVATE_ENDPOINT=true` on the API and worker to allow them for every user.
For a self-hosted endpoint whose hostname resolves to private IPs, set
`RAKAZO_OPENAI_COMPAT_PRIVATE_HOSTS=models.example.test,other.example.test` in the deployment
environment for both API and worker, then recreate those containers. Entries are exact hostnames
(case-insensitive, optional trailing dot), not URLs, suffixes, or wildcards. These hosts ignore
`RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC`; every DNS answer must be private, and metadata and
link-local destinations remain blocked. This applies to discovery and model requests.
HTTPS still validates the hostname's certificate. Like private IP endpoints, trusted hostnames
also permit HTTP with API keys; use HTTPS unless the network is trusted. Only allow hosts you
control. Private endpoints require `MCP_ALLOW_PRIVATE_ENDPOINT=true` for the deployment; no app account bypasses that policy.
If that endpoint's model
accepts images, enable **Supports images** under **Advanced** when connecting so attachments and
screenshot computer tools stay available. Existing connections default to disabled. For centrally
managed endpoints, the deployment-wide fallback remains
`RAKAZO_OPENAI_COMPATIBLE_VISION_MODELS=gpt4o-vision,llava`.

## Thinking

For servers that accept standard `reasoning_effort`, enable **Supports thinking** under
**Advanced** when connecting. The setting is saved on the connection (no env var or restart).
Existing connections default to disabled. Reconnect former Qwen-list or deployment-local models
via **Settings → Models** and turn it on; the old environment list is no longer read.

Enabled connections default to medium thinking. Web and desktop expose **Thinking** in a bot's
advanced settings; mobile inherits the same backend policy. Rakazo sends standard
`reasoning_effort` (`minimal`, `low`, `medium`, `high`, or `none` when off); the server owns
model-specific translation. Leave **Supports thinking** off when the server lacks standard effort
support. Existing token limits still apply; effort is not a separate reasoning-token budget.

## Prompt cache capabilities

The model connection API accepts `cacheCapabilities`, including `scope`,
`retentionMs`, `minimumTokens`, and `retentionMode`. Declare a positive
`retentionMs` only when the endpoint supports prefix reuse for that window.
For these connections with usable history-retrieval tools, the runtime
automatically uses cache-aware context:
recent history remains bounded on a cold request, and subsequent requests keep
that selected prefix while it is likely warm and fits the context budget.
Connections with unknown retention or `retentionMode: "none"` retain the default
retrieval policy. An explicit executor context strategy still takes precedence.
Callers without usable history-retrieval tools keep fitting original history
under the model's context budget instead of replacing it with snapshots.

Cache warmth is advisory. Changing instructions or tools, context pressure,
worker eviction, or a process restart can require fresh prompt processing.
These settings do not create backend KV snapshots or keep a model loaded;
the inference server is responsible for retention and conversation switching.

## Image and video generation

Bot media tools are disabled by default. Configure the worker (and API for inline
execution) with a provider and its generic HTTP connection:

```dotenv
MEDIA_GENERATION_PROVIDER=fal
MEDIA_GENERATION_BASE_URL=https://queue.fal.run
MEDIA_GENERATION_API_KEY=replace-with-media-api-key
MEDIA_GENERATION_IMAGE_MODEL=fal-ai/flux/schnell
MEDIA_GENERATION_VIDEO_MODEL=fal-ai/wan/v2.2-a14b/text-to-video
```

`MEDIA_GENERATION_PROVIDER` accepts `disabled` (the default), `fal`, or `fake`
(for offline testing only). The base URL is optional and defaults to the URL above.
Only set the image/video model fields for capabilities you want enabled. Compatible
servers can use the same connection fields; models must support the corresponding
fal queue API and Flux/Wan input and output shapes. Credentials stay on the server. Set these in
your deployment secret configuration; never commit actual credentials.

Bots use `generate_image` to attach one PNG or `generate_video` to submit a
four-second MP4. The video tool returns a job ID and queued/running status; call it
again with `jobId` to check progress and attach the completed video. Saved jobs
can be polled after worker restarts by the same owner/bot/thread. The first version
requires polling through the bot; it does not automatically deliver jobs in the
background. Use the existing per-bot tool switches and action approval rules to
control access. Both tools require approval by default. Ticket board runs keep
these chat-only media tools unavailable so ticket work stays on the board.

Each run allows at most two submissions (including failures). Submissions are
never retried automatically: a lost response can mean the provider accepted and
charged for the request. Provider errors omit remote response bodies. Configure
account budgets and rate limits with your provider; the run cap is not a currency
budget. Provider 429 responses are returned without automatic retries. Outputs
must fit both the 10 MiB media ceiling and the configured attachment limit;
larger outputs are rejected.

Images use existing inline chat rendering. MP4 files can be previewed with native
video controls on web and Electron and opened/downloaded through the existing
native file flow on mobile. No new mobile player or settings screen is required.

## Voice

### macOS voices

When the API runs on macOS, Voice settings also offers **macOS**, which needs no key. The API renders each reply with the built-in `/usr/bin/say` into an audio clip, so it plays on the listener's device and stops like any other voice. Docker and Linux hosts do not list it.

### Spoken summaries

Off by default. Set `VOICE_SUMMARY_MIN_CHARS` (for example `600`) to have a voice read a bot reply longer than that many characters as a short summary written by that bot's own model. Each summary is an extra model call billed to the bot. The chat keeps the full reply, and if the summary call fails the full reply is read.

### Fish Audio

`FISH_TTS_MODEL` sets the Fish Audio speech model for connections that do not choose one (default
`s2.1-pro`), and `FISH_ASR_MODEL` the transcription model (default `transcribe-1-pro`). Set them on
the API and worker.

### Calls

Bots can call a user in the app, and users can hold to talk, when `PHONE_CALLS_ENABLED=true` is set on
the API and worker. `PHONE_CALL_COOLDOWN_MINUTES` (default `2`) is the minimum time between a bot's
calls to the same person, and `PHONE_CALL_RING_SECONDS` (default `45`) how long an unanswered call
rings.
