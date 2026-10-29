# Build a plugin

A plugin gives Rakazo bots skills, hosted MCP tools, or both. It is a public GitHub repository,
or a folder in one. Rakazo reads the plugin files; it never executes code from the repository.
To list an existing MCP server in the marketplace, wrap its public HTTPS endpoint in the
manifest and MCP config below, test it in Rakazo, then submit the repository.

## 1. Create a plugin folder

Copy the [hello world plugin](https://github.com/elie222/rakazo/tree/main/examples/plugins/hello-world)
for skills, or the [MCP server example](https://github.com/elie222/rakazo/tree/main/examples/plugins/mcp-server)
for hosted tools:

```text
mcp-server/
├── plugin.json
├── mcp.json                   # Optional: hosted MCP servers
├── skills/
│   └── search-docs/
│       └── SKILL.md
├── commands/                  # Optional: slash command prompts
│   └── find-docs.md
└── agents/                    # Optional: helper instructions
    └── docs-researcher.md
```

Include at least one skill, command, agent, or MCP server. A README is useful for people but
is not installed. Publish the folder to GitHub before testing; local folders and private
repositories are not supported sources.

## 2. Write plugin.json

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json",
  "name": "mcp-server",
  "version": "1.0.0",
  "description": "Search documentation through a hosted MCP server.",
  "author": { "name": "Example" },
  "license": "Apache-2.0",
  "keywords": ["docs", "mcp"]
}
```

`name` is required: 1–64 lowercase letters, digits, dots or hyphens, starting and ending with
a letter or digit, with no `--` or `..`. All metadata shown above except `name` and `$schema`
is optional. Also supported: `homepage`, `repository`, and `author.email` / `author.url`.
The author object accepts only `name`, `email`, and `url`.

Rakazo finds the first manifest in this order:

| File | Format | MCP config |
| --- | --- | --- |
| `plugin.json` | Agent Plugins; `$schema` must be the 1.0.0 or 1.1.0 plugin schema | `mcp.json` |
| `.cursor-plugin/plugin.json` | Cursor | `mcp.json`, falling back to `.mcp.json` |
| `.grok-plugin/plugin.json` | Grok | `mcp.json`, falling back to `.mcp.json` |

Component paths are fixed as above; manifest fields cannot relocate them. Unknown Agent Plugins
manifest fields are reported as ignored; `extensions` is accepted but has no effect.

## 3. Add skills, commands, or agents

These are optional when the plugin has an MCP server. A skill can explain when and how to use
its tools. Put this in `skills/search-docs/SKILL.md`:

```markdown
---
name: search-docs
description: Search the connected documentation server. Use when the user asks how a documented feature works or wants a source for an answer.
---

1. Search the documentation server's tools for the user's topic.
2. Read relevant results before answering and link the sources returned by the server.
3. If the server needs authentication, ask the user to connect it in Integrations.
```

Skills require YAML frontmatter with a nonempty `name` (up to 80 characters) and `description`
(up to 2000). Describe when to use the skill in its description. Text references beside
`SKILL.md`, including in subfolders, are installed with it: `.md`, `.mdx`, `.txt`, `.json`,
`.yaml`, `.yml`, and `.csv`.

For a slash command, create `commands/find-docs.md`:

```markdown
---
description: Find documentation for a topic.
---

Search the documentation server for $ARGUMENTS and summarize the relevant sources.
```

This becomes a skill named `find-docs`, invoked as `/find-docs`; `$ARGUMENTS` means the text
after the command. Without frontmatter, the first nonempty body line supplies the description.
Files starting with `_` in `commands/` do not become commands or installed references.

For a helper, create `agents/docs-researcher.md` using the same `name` and `description`
frontmatter as a skill, followed by its instructions. Rakazo converts it to a skill that
instructs the bot to call `run_subagent`; it is not a separate agent runtime or model setting.

Keep names distinct, ignoring case. Duplicate skill names fail parsing; agents and commands
whose names were already collected are ignored (skills take precedence, then agents, then
commands). Built-in skill names such as `interrogate`, or names already installed for the user,
conflict at installation.

## Add an MCP server

**Local stdio servers are not supported in plugins. Host your MCP server at a public
`https://` URL.** A repository containing a server implementation alone is not an installable
plugin; deploy the server and point `mcp.json` at its endpoint.

For the Agent Plugins manifest above, use this complete `mcp.json`:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.1.0/mcp.schema.json",
  "mcpServers": {
    "docs": {
      "type": "streamable-http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "X-Docs-Collection": "public" }
    }
  }
}
```

Replace `https://mcp.example.com/mcp` with your deployed endpoint. It is a placeholder, not a
working server. Each named server becomes a separate MCP connection. A plugin can contain
only the manifest and MCP config; a companion skill is optional.

Agent Plugins supports `streamable-http` and `sse`. The MCP `$schema` must match the manifest's
version, and only `$schema` and `mcpServers` are allowed at the config's top level. Each server
accepts only `type`, `url`, and optional `headers`. Cursor/Grok also accept `http` as an alias
for `streamable-http` and do not require an MCP `$schema`.

URLs cannot contain credentials or fragments. Query parameter names containing `auth`,
`credential`, `key`, `password`, `secret`, or `token` are refused. Endpoints undergo network
safety checks; use a publicly reachable host, not localhost or a private network address.

Headers must be string values with valid HTTP header names: at most 32 headers, each value
up to 4096 characters. Invalid HTTP values (such as embedded newlines) and duplicate names
ignoring case are refused. Static non-secret headers are supported. Never publish credentials
in a plugin, including in headers: every installer would receive the same value.

### How users authenticate

- **OAuth:** after installing the connector, users choose **Sign in** on the plugin's server
  in Integrations and authorize in the browser. Rakazo uses MCP OAuth discovery. If the server
  cannot register a client dynamically, users can edit the server under **Manage MCP servers**
  and supply their registered OAuth client ID and optional client secret in **Advanced**.
- **API key or token:** in **Integrations** → **+** → **Manage MCP servers**, edit the installed server.
  Under **Advanced**, use **Access token (optional)** for a bearer token, or **Header name** / **Header value**
  for a custom header such as `X-API-Key` (or a complete `Authorization` value). Rakazo stores
  credentials encrypted. The MCP server API also supports `secret`, `headers`, and `oauthClient`
  on server updates; these are not plugin manifest fields.
- **No authentication:** a public server can work immediately without sign-in.

There is no plugin setup form or per-user secret declaration in `plugin.json` or `mcp.json`.
`${VAR}` placeholders anywhere in a server entry are rejected; Rakazo neither expands them
from environment variables nor prompts for them. Do not add `env`, `secret`, `oauthClient`,
or setup fields to an Agent Plugins MCP entry. Document your server's authentication needs
in the README and submission testing instructions instead.

## 4. Test in Rakazo

1. Open **Integrations**, choose **+** → **From GitHub**, and paste the public repository URL.
   For a plugin in a folder, use `https://github.com/example/plugins/tree/main/mcp-server`.
   You can also use `https://github.com/example/plugins@main#mcp-server` or pin a full commit SHA.
2. Check the preview's skills, servers, and skipped parts. Fix unsupported parts before submitting.
   Parsing a config is not proof that its server works.
3. Enable the connector and skills you want to test, authenticate each server if needed, and
   enable it for the bot. Ask the bot to use a real tool and try any skills or commands.
   Verify both sign-in and a useful result without publishing credentials.

Preview and installation check the content digest; if files change between them, preview again.
Installed content is pinned to a commit.

### Unsupported parts and limits

Preview reports unsupported parts and can retain the supported ones; marketplace approval
refuses partial plugins. Remove:

- Local `stdio` servers, unsupported transports, invalid MCP config, or unresolved placeholders.
- Editor-only `rules/`, `hooks/`, `automations/`, and `.lsp.json`.
- Scripts, binaries, or other unsupported reference files inside a skill folder.
- Symlinks or submodules used as plugin components or skill references.

The plugin directory is limited to 5000 files; GitHub's repository tree must be complete.
At most 200 component files are fetched (manifests, MCP configs, skills, references, commands,
and agents), each at most 100,000 bytes, with at most 4,000,000 bytes of fetched content.
Each skill may have at most 40 reference files totaling 400,000 bytes, separate from `SKILL.md`.

## 5. Submit to the marketplace

Use [Submit a plugin](https://rakazo.com/plugins/submit/). Supply your email, plugin name,
HTTPS logo URL, public GitHub repository or folder URL, description, and testing instructions;
a website is optional. Confirm you tested it in Rakazo. Describe how to exercise the tools and
authentication without including real credentials.

Or send JSON to the public API; no Rakazo account or API key is required:

```sh
curl -X POST https://app.rakazo.com/api/v1/plugin-submissions \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","name":"Example Docs","logo":"https://example.com/logo.svg","source":"https://github.com/example/plugins/tree/main/mcp-server","description":"Search documentation.","testing":"Install the connector and search the public documentation with a bot.","tested":true}'
```

`name` allows up to 80 characters, `description` 2000, and `testing` 4000. Logo and optional
website must be HTTPS URLs. The [submission API page](https://rakazo.com/plugins/submit.md)
has the field reference. A new submission returns `201` with an `id` and `status: "pending"`.
Validation errors return `400`; oversized bodies (over 32 KiB) return `413`, and the endpoint
limits submissions to 10 per IP per hour (`429`).

Every submission is reviewed. Approval reuses the install preview and checks that the plugin
has at least one skill or MCP server, no unsupported or invalid parts (ignored manifest fields
are allowed), no built-in skill name conflicts, and safe remote endpoints. These checks do
not establish that a tool call or OAuth flow works; provide reproducible testing instructions.
The review result is emailed to the submitted address.

## 6. Publish updates

Push your changes to GitHub, test again, then resubmit through the same form or API.
The same email and normalized source URL update an existing pending submission (`200`);
after review, resubmitting creates a new submission. If you submitted a pinned source, change
the pin to the new commit.

Approval lists the exact commit reviewed. Later pushes do not automatically change the listing;
the newest approval for that repository and folder supplies it. Existing installs remain
pinned too; to test new content, remove the installed plugin and install again from the updated
source. Changing the manifest's `version` alone does not update installs.
