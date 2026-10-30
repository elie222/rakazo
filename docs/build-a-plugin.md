# Build a plugin

## Most plugins wrap an MCP server

Host your tools, describe the connection in two JSON files, then publish them in a public
GitHub repository. Rakazo reads the plugin files; it never runs code from the repository.
Start with the [MCP server example](../examples/plugins/mcp-server/README.md).

### 1. Host your server

Deploy your MCP server at a public HTTPS URL. Local `stdio` servers, localhost, and private
network endpoints are not supported in plugins. A repository containing server code alone
is not an installable plugin.

### 2. Create the plugin files

Put these two files at the repository root, or together in a folder:

```text
mcp-server/
├── plugin.json
└── mcp.json
```

`plugin.json`:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json",
  "name": "mcp-server",
  "version": "1.0.0",
  "description": "Search documentation through a hosted MCP server."
}
```

`mcp.json`:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.1.0/mcp.schema.json",
  "mcpServers": {
    "docs": {
      "type": "streamable-http",
      "url": "https://mcp.example.com/mcp"
    }
  }
}
```

Replace the example URL with your deployed endpoint; it is a placeholder, not a running
server. Each named server becomes a separate connection. `streamable-http` and `sse` are
supported. The MCP `$schema` version must match the plugin `$schema` version.

The manifest requires `$schema` and `name`. Names use 1–64 lowercase letters, digits, dots,
or hyphens, start and end with a letter or digit, and cannot contain `--` or `..`.
`version` and `description` are optional, as are `author` (`name`, `email`, `url`),
`homepage`, `repository`, `license`, and `keywords` (an array of strings).

### Authentication

MCP server entries accept only `type`, `url`, and optional `headers`, a map of HTTP header
names to string values. Use headers only for non-secret configuration, for example
`"headers": { "X-Docs-Collection": "public" }`. Never publish credentials in these files
or put them in the endpoint URL.

- **OAuth:** users choose **Sign in** on the installed server and authorize in the browser.
  Rakazo discovers OAuth from the server; no OAuth fields belong in the plugin files.
  If dynamic client registration is unavailable, users can supply their registered client ID
  and optional secret under **Manage MCP servers** → edit the server → **Advanced**.
- **API key or bearer token:** users open **Integrations** → **+** → **Manage MCP servers**,
  edit the installed server, and expand **Advanced**. Use **Access token (optional)** for a
  bearer token or **Header name** / **Header value** for a custom header.
- **Public tools:** servers without authentication can work immediately.

There is no plugin secret declaration or setup form. `${VAR}` placeholders are rejected,
not expanded or turned into prompts. Describe authentication requirements in your README.

### 3. Add an optional skill

A skill can teach bots when and how to use your tools. Add `skills/search-docs/SKILL.md`:

```markdown
---
name: search-docs
description: Search the connected documentation server. Use when the user asks how a documented feature works or wants a source for an answer.
---

1. Search the documentation server's tools for the user's topic.
2. Read relevant results before answering and link the sources returned by the server.
3. If the server needs authentication, ask the user to connect it in Integrations.
```

Use the actual tool names and workflows your server exposes. Skills require nonempty YAML
`name` (up to 80 characters) and `description` (up to 2000). Keep skill names distinct from
each other and from Rakazo's built-in skills.

### 4. Test in Rakazo

1. Publish your plugin files in a public GitHub repository. Private repositories and local
   folders are not supported sources.
2. Open **Integrations**, choose **+** → **From GitHub**, paste the repository URL, and choose
   **Preview**. For a folder, use `https://github.com/example/plugins/tree/main/mcp-server`.
3. Check the preview's servers, skills, and skipped parts. Choose **Connect** to install the
   connector and **Add skills** in the Skills section if you included skills.
4. Sign in if needed. With a bot selected, choose **Use in this bot** for the server, then
   ask the bot to call a real tool. Verify a useful result and any companion skill.

Fix skipped parts before submitting. A valid config does not prove that tool calls or
sign-in work. Installed content is pinned to a commit; if files change during preview,
preview again.

### 5. Submit to the marketplace

1. Open [Submit a plugin](https://rakazo.com/plugins/submit/), also linked from Integrations.
2. Enter your email, plugin name, HTTPS logo URL, public GitHub repository or folder URL,
   description, and testing instructions. A website URL is optional.
3. Explain how to exercise the tools and authentication without including real credentials.
   Check **I've tested this plugin in Rakazo and it works**, then choose **Submit plugin**.

Every submission is reviewed and the result is emailed to you. Approval checks the plugin
preview and remote endpoint safety, requires at least one skill or MCP server, and refuses
unsupported or invalid parts. Approval lists the exact commit reviewed; later pushes do not
automatically update the listing. Test changes and resubmit through the same form.
The [submission API reference](https://rakazo.com/plugins/submit.md) covers submitting by API.

## Skills-only plugins

For a plugin without tools, copy the [hello world example](../examples/plugins/hello-world/README.md).
Keep `plugin.json` and at least one `skills/<name>/SKILL.md`; omit `mcp.json`. Publish and
preview it through the same GitHub flow, choose **Add**, then try the skill with a bot.
Submit through the same marketplace form.

Optional `commands/<name>.md` files become skills invoked with `/name`; `$ARGUMENTS` is the
text after the command. Optional `agents/<name>.md` files use skill-style frontmatter and
become skills that instruct the bot to call `run_subagent`.

## Compatibility and updates

Rakazo also reads Agent Plugins 1.0.0 and legacy `.cursor-plugin/plugin.json` or
`.grok-plugin/plugin.json` manifests. Legacy formats use `mcp.json` or `.mcp.json` and also
accept `http` as an alias for `streamable-http`. Component locations are fixed; manifest
fields cannot relocate them.

Editor hooks, rules, automations, local MCP execution, and skill scripts or binaries are
not supported. Text references beside a `SKILL.md` can be installed with it; symlinks and
submodules cannot. Keep the plugin small: at most 200 fetched component files, 100,000 bytes
per file, and 4,000,000 bytes total. Each skill allows up to 40 reference files totaling
400,000 bytes.

Existing installs remain pinned. To test an update, remove the installed plugin and install
again from the updated source. Changing `version` alone does not update installs.
