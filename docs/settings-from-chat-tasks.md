# Settings from chat, product help, and lazy tool loading

Goal: a bot can manage Rakazo for its user when asked (its own model,
instructions, voice and profile, plus low-risk user settings), answers questions
about Rakazo from real docs, and the model sees a small tool list that loads the
rest on demand. Every step is measured with tool-choice evals before and after.

## Why

- Users ask bots to switch their model, rewrite their instructions, rename
  themselves and change notifications. Model changes never succeed today: the
  bot says it can't, or guesses which model it runs. The fleet model tool fails
  often because users name models loosely.
- `propose_instructions_update` adds a second path the model keeps missing:
  `update_bot` regularly rejects direct instruction writes and tells the model
  to propose instead. Approval modes already cover users who want review.
- Questions about Rakazo itself (where a setting is, billing, credits, how an
  integration works) get web searches, guessed UI steps, or no reply.
- A run uses a handful of tools, but every model call carries every tool
  definition. Several tools are almost never called.

## Prior art (what we copy)

- T3 Code: one tool per settings area that reads and writes (omit fields to
  read, pass fields to patch); server-side authorization; prompt rule "never
  switch unasked"; NDJSON eval cases with `calls`, `notCalls`, `order`,
  `maxCalls`, split into guard (must act) and control (ordinary work, must not
  touch product tools).
- OpenBot (nightly-labs): ~14 visible tools over a ~115-tool catalog via
  `tool_search` / `tool_describe` / `tool_call`; a CI byte budget on the visible
  tool text; `update_profile` patch tool that may never widen access.
- OpenMausBot: `find_tool` / `use_tool` bridge (BM25, top 3 with schemas,
  pinned tools always listed, same checks as a direct call); golden files pin
  the bridged tool list; profile changes apply immediately with an Undo card;
  runs the owner did not drive wait for approval.
- opencode: a built-in `opencode` skill that indexes the docs and fetches them
  before answering; tool catalog in the prompt capped by a token budget.
- Claude Code: skills listed as one line, body loaded on demand; deferred tool
  schemas behind a search tool. Native `defer_loading` is Anthropic-only, so
  Rakazo needs a provider-neutral bridge (it may use the native path in the
  Anthropic adapter later, behind the same interface).

## Decisions

- One write path for a bot's own settings: `update_bot`. Calling it with no
  fields returns current settings and allowed values; passing fields patches.
- Instructions are written directly. Changes keep history and can be undone.
  Runs not started by the owner (other bots, routines, external messages) keep
  the existing owner-approval hold for self-changes.
- A bot never widens its own powers from chat: credentials, disabled tools,
  fleet management, cross-space communication, computer mode and approval
  preferences stay UI-only. Export and clear are not settings.
- User settings from chat cover low-risk preferences only. Email, password,
  sign-in, billing, deletion and approval rules are excluded.
- Settings change only when the user asks. One prompt line says so; evals
  enforce it.
- Product questions use a built-in help skill, not a new tool.

## Tasks

### 1. Tool-choice eval suite (baseline first)

- [ ] Add a `tool-choice` suite to `packages/testkit` (`pnpm test:evals --suite
      tool-choice`). Each case: optional prior turns, prompt, bot/user state,
      and expectations on built-in tool calls: `calls` (tool + argument
      matchers), `notCalls`, `order`, `maxCalls`. Grade structured calls
      deterministically; reuse the existing judge only for reply meaning.
- [ ] Capture the built-in tool calls a run makes (name + arguments) as
      evidence, and record the tool definition bytes/tokens sent per call.
- [ ] Cases, synthetic only, guard and control, across every tool family, not
      just settings: settings (model by loose name, instructions, name, avatar,
      notifications, thinking, voice, "which model are you?" must read only,
      "you're slow" must not switch model), product help (where is X, billing,
      credits, connect an integration), memory, files, shell, web, schedules,
      scratchpad, tickets, skills, fleet, secrets, ask_user/message_user, and
      plain conversation that must call nothing. Target 60+ cases.
- [ ] `--cases-file <path>` loads extra cases in the same format from a local
      file outside git, for the private held-out set paraphrased from
      production. Never commit it or anything derived verbatim from user data.
- [ ] Record the baseline on Claude Haiku 5.5 via OpenRouter (3 trials) and keep
      the report under ignored `test-report/evals/`.

### 2. Bot settings from chat

- [x] Remove `propose_instructions_update` and its approval wiring; `update_bot`
      accepts `instructions` on the bot's own profile.
- [x] `update_bot` with no fields returns the current settings and allowed
      values (connected models, thinking levels). Voices take a provider call,
      so they are listed only when `voice` is passed and matches nothing.
- [x] Add `model` (resolved from loose names against connected models; a clear
      "connect a provider first" result when none match), `thinking`, `voice`,
      `readAloud`. Same API validation as the settings screen.
      Reuse the same resolution in `set_child_bot_model`. `memoryScope` stays
      in Settings: shared memory widens what the bot reads and exposes.
- [x] Undo for chat-made changes: instructions keep their history; model,
      thinking, voice and read-aloud post a "Settings updated" card whose undo
      writes the previous values back only while the changed ones still hold.
- [x] Prompt: change settings only when the user asks; onboarding self-setup
      (name, description, instructions) stays.
- [x] Eval: settings guard cases pass; controls show no unasked changes.

### 3. User settings from chat

- [x] `update_preferences`: timezone and marketing emails for the user who
      started the run, offered only on runs they started. Read by omitting
      fields. Voice and model preferences stay out: each is tied to a
      connection and its catalog, not a simple value.
- Theme stays out: it is device-local (`@rakazo/ui-tokens` appearance
  preference), not an account setting.
- [ ] Eval cases for each preference and for refused ones (email, billing).

### 4. Product help skill

- [ ] Built-in `rakazo` skill: an index of product topics with links to the
      published docs (`/docs/*.md`, `llms.txt`), loaded via `skill_read`, with
      the instruction to fetch the page before answering. One catalog line
      until used. Must work for self-hosted installs (docs URL from config).
- [ ] Eval: product-question cases read the skill and answer from the docs
      (judge, versioned rubric) instead of guessing or web searching.

### 5. Lazy tool loading

- [x] Provider-neutral bridge: a core set (~12-15 tools, chosen from usage)
      stays listed; the rest are reachable through `find_tool` (returns top
      matches with full schemas) and `use_tool` (runs through the exact same
      gate, approvals and audit as a direct call). The `find_tool` description
      lists hidden tool names grouped by area (no schemas). `find_tool` takes
      exact `names` (lookup) or a `query` (deterministic keyword/BM25 ranking
      over name, description and parameter names, top 3). The tool list never
      changes mid-run, so the prompt cache survives.
- [x] Evals: rare tasks find then use the right tool; common tasks never call
      `find_tool`; `use_tool` is never called on an unloaded or unknown tool.
- [x] Tool activity UI shows the real tool, not `use_tool`.
- [x] Deterministic test pinning the visible tool list and a byte budget for
      tool text; fails CI when it grows.
- [ ] Re-run the full tool-choice suite and the existing product suite; compare
      pass rate, tool calls per run, tokens and cost against the baseline.
      Ship only if pass rate holds.

## Constraints

- Public repo: cases are synthetic; no production text, names, ids or metrics
  in code, cases, commits or PRs.
- Evals stay opt-in and offline by default; live runs only via the CLI.
- Backend owns validation and authorization; tools call the same services as
  the settings screens.
- Separate PRs: (1) eval suite + baseline, then (2)-(4) in parallel, then (5).
