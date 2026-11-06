#!/usr/bin/env python3
"""Turns the screenshot agent's JSON into a section of the pull request description.

The agent browsed a preview built from the pull request, so its JSON and images are
untrusted. Only PNG files it saved, and plain-text captions, get through.

  pr-screenshots.py prepare RESULT_JSON SHOTS_DIR BASE_URL OUT_DIR
      writes OUT_DIR/uploads.txt (one file name per line) and OUT_DIR/section.md
  pr-screenshots.py splice BODY_FILE SECTION_FILE
      prints BODY_FILE with the screenshot section replaced, added, or removed
"""

import json
import re
import sys
from pathlib import Path

START = "<!-- rakazo-pr-screenshots:start -->"
END = "<!-- rakazo-pr-screenshots:end -->"
MAX_SHOTS = 4
MAX_CAPTION = 200
MAX_BYTES = 5 * 1024 * 1024
FILE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.png$")
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


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


def splice(body: str, new_section: str) -> str:
    start = body.find(START)
    end = body.find(END, start + len(START)) if start != -1 else -1
    if start != -1 and end != -1:
        before = body[:start].rstrip()
        after = body[end + len(END) :].lstrip()
    else:
        # A start marker without an end would pair with the next section's end later.
        before, after = body.replace(START, "").rstrip(), ""
    parts = [part for part in (before, new_section, after) if part]
    return "\n\n".join(parts).rstrip() + "\n"


def main(argv: list[str]) -> int:
    if len(argv) == 6 and argv[1] == "prepare":
        _, _, result_json, shots_dir, base_url, out_dir = argv
        try:
            result = json.loads(result_json)
        except json.JSONDecodeError:
            result = None
        selected = select(result, Path(shots_dir))
        out = Path(out_dir)
        out.mkdir(parents=True, exist_ok=True)
        (out / "uploads.txt").write_text("".join(f"{name}\n" for name, _ in selected))
        (out / "section.md").write_text(section(selected, base_url))
        return 0
    if len(argv) == 4 and argv[1] == "splice":
        body = Path(argv[2]).read_text()
        sys.stdout.write(splice(body, Path(argv[3]).read_text().strip()))
        return 0
    sys.stderr.write(__doc__ or "")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
