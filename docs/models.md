# Models

Choose which AI models your bots think with, using your own subscription, your own API key, or a
model you run yourself.

## Connect a provider

Open **Settings → Models**. Under **Add provider**, pick a provider and connect it:

- **Sign in** with a ChatGPT or Claude subscription to use the plan you already pay for.
- **Connect API key** for OpenAI, Anthropic, Google, OpenRouter and many others.
- **OpenAI-compatible server URL** for a model you host yourself, such as Ollama or vLLM on your own
  machine. Paste the address, choose **Find models**, and pick one. Under **Advanced** you can set
  its context limit, whether it supports images, and its reasoning effort.

Connected providers are listed under **Providers** and are available in every [space](./spaces.md).

> [!NOTE]
> On rakazo.com you can skip this and choose **Use Rakazo credits**, which includes monthly model
> credits. See [Account and billing](./account.md).

## Main model and fallbacks

**Main model** is what every bot uses unless you choose otherwise. Choose **Add fallback** to list
backup models; if the main model fails or hits a limit, the bot moves to the next one. **Move up**
and **Move down** set the order.

Each model has a **Thinking** level, from **Minimal** to **Max**. Higher thinking is slower and
costs more, and helps on hard, multi-step work.

## Approval model

**Approval model** is the model that checks bot actions when approvals are set to **Auto**. A fast,
inexpensive model works well here. See [Approvals](./approvals.md).

## Per bot and per routine

To give one bot a different model, open its settings, expand **Advanced**, and choose its **Model**
and **Thinking**. A [routine](./routines.md) can also have its own model, for example a cheaper one
for a simple daily check.

> [!TIP]
> Bots that use the computer's screen need a model that can read images. Models that can't are
> marked **Can't read images** in the picker.

## Usage

**Settings → Usage** shows runs, tokens and cost by model.


## Compatible server wire protocol

OpenAI-compatible connections default to Chat Completions. For an endpoint that serves the Responses
API, the shared `models/connect` RPC accepts `apiProtocol: "responses"` alongside `provider:
"openai-compatible"`, `baseUrl`, and `modelId`. Use `apiProtocol: "chat-completions"` to switch back.
This optional API setting applies to one saved connection; it does not change other connections or
require an environment variable. Current settings screens retain a saved protocol when editing the
same endpoint. Changing the base URL without specifying a protocol resets it to Chat Completions.
The same private-endpoint opt-in, HTTPS, redirect and custom-header checks apply to both protocols.
