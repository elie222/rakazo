#!/usr/bin/env node
// Optional connector process: no database, server configuration or other adapters are loaded.
const { runDriveMcpServer } = await import("@rakazo/adapters/google-drive-mcp");
await runDriveMcpServer();
