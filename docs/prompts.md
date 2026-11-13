# Prompts and tool definitions

Keep authored model instructions and pure prompt builders beside their feature in
`*.prompt.ts`. Keep tool names, descriptions, parameter descriptions and schemas
together in `*.tool-definition.ts`; execution and authorization stay outside those
files. These names make model-facing changes recognizable in a diff.

Find the definitions with:

```sh
rg --files packages apps | rg '\.(prompt|tool-definition)\.ts$'
```

The main entry points are:

- `packages/adapters/src/run-instructions.prompt.ts`: main turn instructions and
  capability-dependent guidance.
- `packages/adapters/src/builtin.tool-definition.ts`: built-in tool descriptions
  and input schemas.
- `packages/adapters/src/run-replies.prompt.ts` and `continuation.prompt.ts`:
  reply, silence and continuation guidance.
- `packages/adapters/src/auto-review.prompt.ts` and `team-chat-judge.prompt.ts`:
  approval and engagement judges.
- `packages/adapters/src/history-compaction.prompt.ts` and
  `apps/api/src/speech-summary.prompt.ts`: conversation and spoken summaries.
- The remaining prompt files cover shared messaging, helper tasks, memory,
  attachments, time, workspaces and task catalogs.

## Automatic versioning

`runs.promptVersion` remains one automatically calculated behavior fingerprint.
It includes the authored definition files, rendered built-in tools, history format,
context policy and the existing representative prompt renderings. Do not bump a
version number or register a new definition file.

`promptSourceVersion` discovers every `*.prompt.ts` and `*.tool-definition.ts`
beneath `packages/*/src` and `apps/*/src`, including nested folders. It hashes sorted
relative filenames and file contents, normalizing line endings. Changes to code,
comments, formatting and filenames inside that surface also change the fingerprint.
This intentionally favors detecting a change over claiming semantic equivalence.

Development reads these files on the first version calculation. The server bundler
embeds the same source fingerprint in production artifacts, so deployed servers do
not need source files. The final version still includes rendered built-in tool
schemas and descriptions because instance settings can affect them. It is cached
for the process lifetime; restart development processes after changing definitions.

Only authored definitions enter the source hash. User messages, bot instructions,
credentials, memory contents and tool responses are never read by this discovery.
Connected tool definitions, installed skills and other per-run configuration are
not captured by this release fingerprint. New authored model instructions belong
in the named definition files; discovery cannot recognize prose hidden in arbitrary
implementation files.

## Comparing outcomes

`scripts/prompt-version-outcomes.sql` groups completed runs by the recorded version.
It reports operational signals, not answer quality or proof that a prompt caused a
change. Account for model, trigger and task differences when comparing versions.
The field describes the latest attempt and is recorded after setup, so setup
failures and older runs may have no version. This cleanup does not add per-call
versions for auxiliary judges or summaries.

Keep prompt wording unchanged in organization-only changes. Existing offline
behavior tests cover assembly and tool contracts; the source-version tests cover
automatic discovery, conditional edits, schemas and production embedding.
