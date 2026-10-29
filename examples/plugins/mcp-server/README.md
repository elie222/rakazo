# MCP server plugin

A minimal Rakazo plugin with a hosted MCP connection and a skill explaining when to use it.
Copy this folder, replace `https://mcp.example.com/mcp` in `mcp.json` with your public HTTPS
MCP endpoint, and publish it in a public GitHub repository. The example URL is a placeholder;
this folder does not run or deploy a server. Local stdio servers are not supported in plugins.

To try your copy, open **Integrations** in Rakazo, choose **+** → **From GitHub**, and paste
your repository or plugin folder URL. Install the connector and skill, authenticate the server
if needed, enable it for a bot, and ask the bot to search your documentation.

Keep keys out of the repository. Users sign in with the server's OAuth flow or edit the
installed connection under **Manage MCP servers** to supply their own bearer token or header.
The `X-Docs-Collection` header is an example of static, non-secret configuration; adjust or
remove it for your server. `${VAR}` placeholders do not prompt users for keys and are refused.

See [Add an MCP server](https://rakazo.com/docs/build-a-plugin/#add-an-mcp-server) for config,
authentication, testing, and marketplace submission steps.
