# Troubleshooting

When an error offers **Troubleshoot**, follow that link for the cause and recovery steps.
If you do not run the server, share the guide with your server administrator.

## Get help from an AI assistant

You can give this page, the error code, and the app version to an AI assistant for help
applying the instructions to your setup. Copy this prompt and fill in the placeholders:

```text
Help me troubleshoot Rakazo using this guide:
https://rakazo.com/docs/troubleshooting/

Error code: <code from the relevant section below>
App version: <version>
Installation method: <published Docker images, source, or other>
What I was doing: <action that failed>

Read the relevant section before recommending changes. Ask for any missing details.
Explain what each change does and how to verify it. Do not request passwords, API keys,
access tokens, cookies, or an entire .env file. Ask only for the specific non-secret
settings needed. Do not disable authentication or URL validation to bypass the error.
```

Review proposed commands before running them. If the guide does not resolve the error,
[report a bug](https://github.com/elie222/rakazo/issues) with the error code, version,
installation method, and steps to reproduce. Remove secrets and personal information first.

## MCP OAuth redirect mismatch

**Code:** `MCP_OAUTH_REDIRECT_MISMATCH`

**Message:** “The sign-in address does not match this server's configuration.” Older
versions show “MCP OAuth redirect URI is not allowed”.

The app uses the address in your browser to build its sign-in callback. The API only
allows the callback configured through `WEB_ORIGIN`. This error means those URLs differ;
it happens before the external service's sign-in flow starts.

1. Copy the origin from the browser address: scheme, hostname, and port, without a path.
   For example, `https://app.example.com` or `http://127.0.0.1:5173`.
2. Check the API's effective `WEB_ORIGIN`. If it is the intended public address, open Rakazo
   at that address instead. `localhost` and `127.0.0.1` differ for this check, as do
   HTTP and HTTPS or different ports.
3. If the configuration is wrong, set `WEB_ORIGIN` to the address people actually use.
   For a public deployment, use its HTTPS origin and align `BETTER_AUTH_URL` and `API_URL`
   as described in the [self-hosting guide](./self-host.md). For local source development,
   `API_URL` can still name the separate API listener.
4. Restart the API with the updated environment. With Docker Compose, recreate the API
   service using the same Compose files and environment file as your installation;
   restarting an existing container alone does not update its environment.
5. Open the chosen address and reconnect the integration. Sign-in should now proceed
   past this error.

If you registered an OAuth client yourself, its allowed redirect URI must also match
`<WEB_ORIGIN>/mcp/oauth/callback`. That is a separate check by the external service;
see [MCP servers](./self-host-integrations.md#mcp-servers).
