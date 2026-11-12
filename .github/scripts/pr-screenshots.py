#!/usr/bin/env python3
"""Turns the screenshot agent's JSON into a section of the pull request description.

The agent browsed a preview built from the pull request, so its JSON and images are
untrusted. Only PNG files it saved, and plain-text captions, get through.

  pr-screenshots.py ready REPO SHA
      prints "ready" when trusted preview deployment and E2E publication have finished
  pr-screenshots.py prompt PROMPT_FILE PR_JSON_FILE DIFF_FILE
      prints the agent's prompt, cut to fit in one environment variable
  pr-screenshots.py prepare RESULT_JSON SHOTS_DIR BASE_URL OUT_DIR
      writes OUT_DIR/uploads.txt (one file name per line) and OUT_DIR/section.md
  pr-screenshots.py retain BODY_FILE SECTION_FILE SHA
      prints the new section with existing current-commit captures retained
  pr-screenshots.py splice BODY_FILE SECTION_FILE
      prints BODY_FILE with the screenshot section replaced, added, or removed
"""

import json
import re
import sys
import subprocess
from pathlib import Path

START = "<!-- rakazo-pr-screenshots:start -->"
END = "<!-- rakazo-pr-screenshots:end -->"
MAX_SHOTS = 4
MAX_CAPTION = 200
MAX_BYTES = 5 * 1024 * 1024
FILE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.png$")
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
# The action passes the prompt, and all its inputs as JSON, in environment variables; Linux
# refuses to start a process when one is over 128 KiB.
MAX_PROMPT_JSON = 100_000
MAX_BODY_JSON = 16_000
MAX_FILES = 300


def json_size(text: str) -> int:
    return len(json.dumps(text))


def fit(text: str, budget: int) -> str:
    """The longest start of text whose JSON form fits in budget bytes."""
    if json_size(text) <= budget:
        return text
    low, high = 0, len(text)
    while low < high:
        mid = (low + high + 1) // 2
        if json_size(text[:mid]) <= budget:
            low = mid
        else:
            high = mid - 1
    return text[:low]


def prompt(instructions: str, pr: dict, diff: str) -> str:
    pr = dict(pr)
    pr["body"] = fit(str(pr.get("body") or ""), MAX_BODY_JSON)
    pr["existing_e2e_screenshots"] = fit(str(pr.get("existing_e2e_screenshots") or ""), 24_000)
    pr["changed_files"] = list(pr.get("changed_files") or [])[:MAX_FILES]
    head = f"{instructions.rstrip()}\n\n<pull_request>\n{json.dumps(pr, indent=2)}\n</pull_request>\n\n<diff>\n"
    tail = "\n</diff>\n"
    return head + fit(diff, MAX_PROMPT_JSON - json_size(head + tail)) + tail


def obsolete(pr: dict, sha: str) -> bool:
    """Author-editable description content never proves a completed assessment."""
    return pr.get("state") != "open" or pr.get("head", {}).get("sha") != sha


def evidence(pages: list, sha: str) -> str:
    """Only current-commit gallery comments from the trusted publisher are evidence."""
    return "\n\n".join(
        comment["body"][:24_000]
        for page in pages
        for comment in page
        if comment.get("user", {}).get("login") == "github-actions[bot]"
        and "<!-- rakazo-playwright-screenshots -->" in (comment.get("body") or "")
        and f"<!-- screenshot-commit:{sha} -->" in comment["body"]
    )[:24_000]


def api(path: str, *, paginate: bool = False):
    command = ["gh", "api", path]
    if paginate:
        command += ["--paginate", "--slurp"]
    return json.loads(subprocess.run(
        command, check=True, capture_output=True, text=True, timeout=30,
    ).stdout)


SOURCE_WORKFLOWS = {
    "preview": ".github/workflows/preview-deploy.yml",
    "e2e": ".github/workflows/publish-playwright-report.yml",
}


def trusted_artifact(repo: str, name: str, workflows: list[str]) -> bool:
    """Check immutable artifact provenance; never download artifact contents.

    A PR can upload the same name, but cannot change its source run metadata.
    Parent runs may still be active while calling this reusable workflow.
    """
    pages = api(f"repos/{repo}/actions/artifacts?name={name}&per_page=100", paginate=True)
    for page in pages:
        for artifact in page["artifacts"]:
            if artifact["name"] != name or artifact["expired"]:
                continue
            run = api(f"repos/{repo}/actions/runs/{artifact['workflow_run']['id']}")
            if (
                run["event"] == "workflow_run"
                and run["path"].split("@", 1)[0] in workflows
                and run["head_repository"]["full_name"] == repo
            ):
                return True
    return False


def sources_ready(repo: str, sha: str) -> bool:
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("Expected a commit SHA")
    return all(
        trusted_artifact(repo, f"pr-screenshot-{source}-{sha}", [workflow])
        for source, workflow in SOURCE_WORKFLOWS.items()
    )


def assessed(repo: str, pr: str, sha: str) -> bool:
    if not re.fullmatch(r"[0-9a-f]{40}", sha) or not re.fullmatch(r"[1-9][0-9]*", pr):
        raise ValueError("Expected a pull request number and commit SHA")
    return trusted_artifact(repo, f"pr-screenshot-reviewed-{pr}-{sha}", list(SOURCE_WORKFLOWS.values()))


def clean_caption(value: object) -> str:
    text = " ".join(str(value).split())[:MAX_CAPTION]
    # GitHub links bare addresses even when escaped, so a caption with one is dropped.
    if re.search(r"://|www\.|[A-Za-z0-9-]\.[A-Za-z]{2,}(/|\b)", text):
        return ""
    # Plain text only: no links, images, HTML, mentions, or markers.
    return re.sub(r"([\\`*_{}\[\]()<>#!|@~])", r"\\\1", text)


def select(result: object, shots_dir: Path) -> list[tuple[str, str]]:
    shots = result.get("screenshots") if isinstance(result, dict) else None
    if not isinstance(shots, list):
        return []
    selected: list[tuple[str, str]] = []
    for shot in shots:
        if len(selected) == MAX_SHOTS:
            break
        if not isinstance(shot, dict):
            continue
        name = shot.get("file")
        if not isinstance(name, str) or not FILE_NAME.match(name) or ".." in name:
            continue
        if any(name == chosen for chosen, _ in selected):
            continue
        path = shots_dir / name
        if path.is_symlink() or not path.is_file():
            continue
        if path.stat().st_size > MAX_BYTES:
            continue
        with path.open("rb") as image:
            if image.read(len(PNG_MAGIC)) != PNG_MAGIC:
                continue
        selected.append((name, clean_caption(shot.get("caption", ""))))
    return selected


def section(selected: list[tuple[str, str]], base_url: str) -> str:
    if not selected:
        return ""
    lines = [START, "## Screenshots", ""]
    for name, caption in selected:
        if caption:
            lines.append(caption)
            lines.append("")
        lines.append(f"![{name}]({base_url.rstrip('/')}/{name})")
        lines.append("")
    lines.append(END)
    return "\n".join(lines)


def retain_section(body: str, new_section: str, sha: str) -> str:
    """Keep current-commit images the agent may have used to establish coverage."""
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("Expected a commit SHA")
    start = body.find(START)
    end = body.find(END, start + len(START)) if start != -1 else -1
    existing = body[start:end + len(END)] if start != -1 and end != -1 else ""
    marker = f"<!-- screenshot-commit:{sha} -->"
    if marker not in existing:
        return new_section
    if not new_section:
        return existing
    additions = "\n".join(
        line for line in new_section.splitlines()
        if line not in (START, END, "## Screenshots", marker)
    ).strip()
    return existing[:-len(END)].rstrip() + "\n\n" + additions + "\n" + END


def splice(body: str, new_section: str) -> str:
    start = body.find(START)
    end = body.find(END, start + len(START)) if start != -1 else -1
    if not new_section and start == -1:
        return body
    if start != -1 and end != -1:
        if body[start:end + len(END)] == new_section:
            return body
        before = body[:start].rstrip()
        after = body[end + len(END) :].lstrip()
    else:
        # A start marker without an end would pair with the next section's end later.
        before, after = body.replace(START, "").rstrip(), ""
    parts = [part for part in (before, new_section, after) if part]
    return "\n\n".join(parts).rstrip() + "\n"


def main(argv: list[str]) -> int:
    if len(argv) == 4 and argv[1] == "ready":
        if sources_ready(argv[2], argv[3]):
            print("ready")
        return 0
    if len(argv) == 2 and argv[1] == "contract":
        contract = json.loads(Path(__file__).with_name("pr-screenshot-contract.json").read_text())
        print("tools=" + ",".join(f"mcp__playwright__{tool}" for tool in contract["tools"]))
        print("schema=" + json.dumps(contract["schema"], separators=(",", ":")))
        return 0
    if len(argv) == 5 and argv[1] == "assessed":
        if assessed(argv[2], argv[3], argv[4]):
            print("complete")
        return 0
    if len(argv) == 4 and argv[1] == "obsolete":
        return 0 if obsolete(json.loads(Path(argv[2]).read_text()), argv[3]) else 1
    if len(argv) == 4 and argv[1] == "evidence":
        sys.stdout.write(evidence(json.loads(Path(argv[2]).read_text()), argv[3]))
        return 0
    if len(argv) == 5 and argv[1] == "prompt":
        instructions, pr = (Path(path).read_text(errors="replace") for path in argv[2:4])
        # Only the start of a huge diff can fit, so the rest is never read.
        with open(argv[4], "rb") as file:
            diff = file.read(MAX_PROMPT_JSON).decode(errors="replace")
        sys.stdout.write(prompt(instructions, json.loads(pr), diff))
        return 0
    if len(argv) == 6 and argv[1] == "prepare":
        _, _, result_json, shots_dir, base_url, out_dir = argv
        try:
            result = json.loads(result_json)
        except json.JSONDecodeError:
            return 2
        if not isinstance(result, dict) or not isinstance(result.get("screenshots"), list) or type(result.get("complete")) is not bool:
            return 2
        selected = select(result, Path(shots_dir))
        if len(selected) != len(result["screenshots"]):
            sys.stderr.write("Every selected screenshot must pass publication validation.\n")
            return 2
        out = Path(out_dir)
        out.mkdir(parents=True, exist_ok=True)
        (out / "uploads.txt").write_text("".join(f"{name}\n" for name, _ in selected))
        (out / "section.md").write_text(section(selected, base_url))
        return 0
    if len(argv) == 5 and argv[1] == "retain":
        sys.stdout.write(retain_section(Path(argv[2]).read_text(), Path(argv[3]).read_text().strip(), argv[4]))
        return 0
    if len(argv) == 4 and argv[1] == "splice":
        body = Path(argv[2]).read_text()
        sys.stdout.write(splice(body, Path(argv[3]).read_text().strip()))
        return 0
    sys.stderr.write(__doc__ or "")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
