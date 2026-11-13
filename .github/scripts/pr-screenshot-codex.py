"""Configure the Codex adapter with the same browser allowlist as the Claude adapter."""

import json
import sys
from pathlib import Path

CONTRACT = json.loads(Path(__file__).with_name("pr-screenshot-contract.json").read_text())
TOOLS = CONTRACT["tools"]
SCHEMA = CONTRACT["schema"]


def configure(mcp_path: Path, home: Path):
    server = json.loads(mcp_path.read_text())["mcpServers"]["playwright"]
    # JSON strings/arrays are valid TOML values here. Only trusted workflow configuration
    # reaches this file; none of the PR or browser content becomes configuration.
    config = f'''approval_policy = "never"
model_provider = "openai"
forced_login_method = "chatgpt"
cli_auth_credentials_store = "file"
web_search = "disabled"
default_permissions = "screenshots"

[permissions.screenshots]
extends = ":read-only"

[permissions.screenshots.filesystem]
{json.dumps(str(home))} = "deny"

[features]
shell_tool = false
view_image = false
multi_agent = false
image_generation = false

[mcp_servers.playwright]
command = {json.dumps(server["command"])}
args = {json.dumps(server["args"])}
enabled_tools = {json.dumps(TOOLS)}
'''
    (home / "config.toml").write_text(config)
    (home / "schema.json").write_text(json.dumps(SCHEMA))


if __name__ == "__main__":
    configure(Path(sys.argv[1]), Path(sys.argv[2]))
