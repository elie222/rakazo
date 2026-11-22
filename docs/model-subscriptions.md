# Model subscriptions

Can you use the AI plan you already pay for? It depends on the plan: some support a Rakazo
connection, while others cover only the provider's own apps. Subscription allowances and API
billing are often separate.

## ChatGPT

**Yes, through ChatGPT sign-in.** Open **Settings → Models**, find **OpenAI Codex**, and choose
**Sign in with ChatGPT**. You need an eligible plan with available Codex usage. Available models
can differ from those in the ChatGPT app.

Connecting an **OpenAI API key** instead uses separate API billing, not your subscription allowance.
See the [official OpenAI authentication documentation](https://learn.chatgpt.com/docs/auth#openai-authentication).

## Claude

**Yes, through Claude sign-in.** Open **Settings → Models**, find **Anthropic**, and choose
**Sign in with Claude**. You need a Claude Pro or Max plan. Usage counts against your plan's
limits.

Connecting an **Anthropic API key** instead uses separate API billing, not your subscription allowance.

Your use remains subject to Anthropic's terms, including its
[authentication and credential rules](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use).

If you self-host from a source checkout for yourself, you can also run models through the official
[Claude Code CLI](./self-host-models.md#claude-code-cli), signed in on the host with your own account.

## OpenCode

**Yes, for coding-agent workloads, through an OpenCode Go API key.** In **Settings → Models**, find **OpenCode Go**
under **Add provider**, choose **Connect API key**, and paste your OpenCode key.

Go is intended for coding-agent traffic, including compatible third-party coding agents. Check
[OpenCode's usage rules and limits](https://opencode.ai/docs/console/go/) before using it for your
bot's workflow.

**OpenCode Zen / pay-as-you-go** uses the **OpenCode** provider instead. Connect its API key;
usage comes from your OpenCode credit balance rather than Go's allowance. Its free-tier chat
models require the OpenCode app and are not offered in Rakazo. See [OpenCode's model documentation](https://opencode.ai/docs/console/models/).

## Other subscriptions

Check the exact plan before connecting or buying it:

- **Gemini:** API keys use the Gemini API's own [billing tiers and limits](https://ai.google.dev/gemini-api/docs/billing).
  Do not assume a Google AI app subscription funds API requests.
- **Kimi:** Code membership and Moonshot's general API have different keys, endpoints, and billing.
  Check the [Kimi account documentation](https://www.kimi.ai/help/kimi-code/faq) for your plan.
- **Copilot, Grok, and other coding plans:** check the provider's current terms, eligible clients,
  and included models. A sign-in option alone does not establish permission for every Rakazo workload.

You need both a connection Rakazo supports and permission from the provider for your intended use.
For compatible APIs, see [Models](./models.md) for custom server connections.

## Billing and limits

Your provider's allowance, charges, and rate limits apply when you connect your own account.
This does not add Rakazo model credits or change your Rakazo hosting plan.

A [fallback model](./models.md#main-model-and-fallbacks) can use a separately billed connection
when your subscription reaches a limit. See [Account and billing](./account.md).
