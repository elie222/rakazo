"""Check that model output reaches GitHub only as allowlisted labels, using a fake gh."""

import json
import re
import os
import pathlib
import subprocess
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).with_name("apply-issue-triage.sh").resolve()

FAKE_GH = r"""#!/usr/bin/env bash
echo "$*" >> "$CALLS"
args=("$@")
jq_filter=""
for ((i = 0; i < ${#args[@]}; i++)); do
  [[ "${args[i]}" == --jq ]] && jq_filter="${args[i + 1]}"
done
case "$*" in
  *"--json labels"*) jq -c "$jq_filter" <<<"{\"labels\": $LABELS}" ;;
  *"--json comments"*) jq -r "$jq_filter" <<<"{\"comments\": $COMMENTS}" ;;
  *"--json url"*) [[ "$3" == 5 || "$3" == 10 ]] && echo "https://github.com/o/r/issues/5" || echo "https://github.com/o/r/pull/$3" ;;
esac
"""


def result(**overrides):
    value = {"type": "bug", "size": "small", "priority_high": False, "duplicate_of": None, "reason": "r"}
    value.update(overrides)
    return json.dumps(value)


def run(model_output, labels=(), comments=()):
    with tempfile.TemporaryDirectory() as directory:
        root = pathlib.Path(directory)
        (root / "gh").write_text(FAKE_GH)
        (root / "gh").chmod(0o755)
        env = {
            "PATH": f"{root}:{os.environ['PATH']}",
            "CALLS": str(root / "calls"),
            "LABELS": json.dumps([{"name": name} for name in labels]),
            "COMMENTS": json.dumps([{"body": body} for body in comments]),
            "GITHUB_REPOSITORY": "o/r",
            "GITHUB_STEP_SUMMARY": str(root / "summary"),
            "ISSUE": "9",
            "RESULT": model_output,
        }
        subprocess.run(["bash", str(SCRIPT)], env=env, check=True, capture_output=True)
        calls = (root / "calls").read_text().splitlines()
        writes = [call for call in calls if call.startswith(("issue edit", "issue comment"))]
        return writes, (root / "summary").read_text()


class ApplyIssueTriageTests(unittest.TestCase):
    def test_workflow_schema_matches_script_allowlist(self):
        workflow = (SCRIPT.parents[1] / "workflows" / "issue-triage.yml").read_text()
        schema = json.loads(re.search(r"--json-schema '(.+)'", workflow).group(1))
        allowlist = json.loads(re.search(r"^TYPES='(.+)'$", SCRIPT.read_text(), re.M).group(1))
        self.assertEqual(schema["properties"]["type"]["enum"], allowlist)

    def test_applies_type_size_priority_and_duplicate(self):
        writes, _ = run(result(type="enhancement", size="large", priority_high=True, duplicate_of=5))
        self.assertEqual(
            writes,
            [
                "issue edit 9 --repo o/r --add-label enhancement,size:large,priority:high",
                "issue comment 9 --repo o/r --body Possibly a duplicate of #5.",
            ],
        )

    def test_drops_values_outside_the_allowlist(self):
        writes, summary = run(
            result(type="wontfix,security", size='huge",x', priority_high="true", duplicate_of="5", reason="::add-mask::x" * 100)
        )
        self.assertEqual(writes, [])
        self.assertEqual(len(summary.rstrip("\n")), 500)

    def test_keeps_existing_type_and_size(self):
        self.assertEqual(run(result(type="enhancement", size="large"), labels=["bug", "size:small"])[0], [])

    def test_skips_size_for_existing_question(self):
        self.assertEqual(run(result(type="bug"), labels=["question"])[0], [])

    def test_duplicate_must_be_another_real_issue_not_already_noted(self):
        self.assertEqual(run(result(duplicate_of=9), labels=["bug", "size:small"])[0], [])
        self.assertEqual(run(result(duplicate_of=10), labels=["bug", "size:small"])[0], [])
        self.assertEqual(run(result(duplicate_of=7), labels=["bug", "size:small"])[0], [])
        noted = run(result(duplicate_of=5), labels=["bug", "size:small"], comments=["Possibly a duplicate of #5."])
        self.assertEqual(noted[0], [])


if __name__ == "__main__":
    unittest.main()
