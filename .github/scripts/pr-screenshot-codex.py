"""Configure the Codex agent: the browser allowlist, read-only shell, and the credential proxy as its model provider."""

import json
import sys
from pathlib import Path

CONTRACT = json.loads(Path(__file__).with_name("pr-screenshot-contract.json").read_text())
TOOLS = CONTRACT["tools"]
SCHEMA = CONTRACT["schema"]


def configure(mcp_path: Path, home: Path, proxy_port: int):
    server = json.loads(mcp_path.read_text())["mcpServers"]["playwright"]
    # JSON strings/arrays are valid TOML values here. Only trusted workflow configuration
    # reaches this file; none of the PR or browser content becomes configuration.
    config = f'''approval_policy = "never"
model_provider = "credential-proxy"
web_search = "disabled"
# The working directory is empty, but never load instruction files from the pull request.
project_doc_max_bytes = 0
default_permissions = "screenshots"

[permissions.screenshots]
extends = ":read-only"

[permissions.screenshots.filesystem]
{json.dumps(str(home))} = "deny"

# The login stays with codex-credential-proxy.py, so this home holds no token to find.
[model_providers.credential-proxy]
name = "credential-proxy"
base_url = "http://127.0.0.1:{proxy_port}/backend-api/codex"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false

[features]
view_image = false
multi_agent = false
image_generation = false

[mcp_servers.playwright]
command = {json.dumps(server["command"])}
args = {json.dumps(server["args"])}
enabled_tools = {json.dumps(TOOLS)}
# With approval_policy "never", Codex refuses every MCP call that is not pre-approved.
default_tools_approval_mode = "approve"
'''
    (home / "config.toml").write_text(config)
    (home / "schema.json").write_text(json.dumps(SCHEMA))


if __name__ == "__main__":
    configure(Path(sys.argv[1]), Path(sys.argv[2]), int(sys.argv[3]))
