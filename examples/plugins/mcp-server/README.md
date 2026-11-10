# MCP server plugin

A manifest, a hosted MCP connection, and an optional skill teaching bots to use it.

1. Copy this folder into a public GitHub repository.
2. Replace `https://mcp.example.com/mcp` in `mcp.json` with your public HTTPS MCP endpoint.
   The example URL is a placeholder; this folder does not run or deploy a server.
   Rakazo never runs repository code or local stdio servers from plugins.
3. Open **Integrations** → **+** → **From GitHub**, paste your repository or folder URL,
   and choose **Preview**, then **Connect**. Choose **Add skills** under Skills to try the companion skill.
4. Sign in if needed, choose **Use in this bot** with a bot selected, and ask it to search your docs.

Keep credentials out of the repository. OAuth uses server discovery and per-user sign-in.
For a token or custom header, edit the installed server under **Manage MCP servers** → **Advanced**.
`mcp.json` accepts optional static, non-secret `headers`; `${VAR}` placeholders are rejected.

Follow [Build a plugin](https://rakazo.com/docs/build-a-plugin/) for configuration and marketplace submission.
For a plugin without tools, see [Hello world](../hello-world/README.md).
