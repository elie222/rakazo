import json
import runpy
import subprocess
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

reclaim_capacity = runpy.run_path(Path(__file__).with_name("reclaim-capacity.py"))["reclaim_capacity"]
NOW = datetime(2026, 11, 19, 14, tzinfo=timezone.utc)


class ReclaimCapacityTest(unittest.TestCase):
    def reclaim(self, counts, prs, machines, *, latest=None, resumed=()):
        def fly_get(path):
            if path == "apps?org_slug=preview-org":
                return {
                    "total_apps": len(counts),
                    "apps": [{"name": name, "machine_count": count} for name, count in counts.items()],
                }
            machine_list = machines[path.removeprefix("apps/").removesuffix("/machines")]
            if machine_list is None:
                raise HTTPError("", 404, "Not Found", None, None)
            return machine_list

        pages = [[{"number": number, "updated_at": stamp} for number, stamp in prs]]
        pull_requests = {number: {"state": "open", "updated_at": stamp} for number, stamp in prs}
        pull_requests.update(latest or {})

        def github_api(args, **_):
            if "--slurp" in args:
                return json.dumps(pages)
            return json.dumps(pull_requests[int(args[2].rsplit("/", 1)[1])])

        def run(args, **_):
            failed = args[:3] == ["flyctl", "machine", "destroy"] and args[3] in resumed
            return subprocess.CompletedProcess(args, int(failed))

        with (
            patch.dict(reclaim_capacity.__globals__, fly_get=fly_get),
            patch("subprocess.check_output", side_effect=github_api) as github,
            patch("subprocess.run", side_effect=run) as cleanup,
        ):
            reclaim_capacity("preview-org", "owner/repo", "preview", 123, 90, NOW)
        removed = [call.kwargs["env"]["PR"] for call in cleanup.call_args_list if "env" in call.kwargs]
        return github.call_count, removed

    def test_below_threshold_or_existing_machine_skips_cleanup(self):
        self.assertEqual(self.reclaim({"other-app": 89}, [], {}), (0, []))
        self.assertEqual(self.reclaim({"other-app": 89, "preview-123": 1}, [], {}), (0, []))

    def test_reclaims_ten_oldest_eligible_previews_at_threshold(self):
        old = "2026-11-18T00:00:00Z"
        recent = "2026-11-19T13:30:00Z"
        counts = {f"preview-{number}": 1 for number in range(1, 18)}
        counts.update({"unrelated-app": 71, "preview-main": 1, "preview-123": 0, "preview-18": 1})
        prs = [(number, old) for number in reversed(range(1, 18))] + [(18, recent), (123, old)]
        machines = {
            f"preview-{number}": [{"id": str(number), "state": "suspended", "updated_at": old}]
            for number in range(1, 18)
        }
        machines["preview-1"] = [{"state": "started", "updated_at": old}]
        machines["preview-2"] = [{"state": "stopped", "updated_at": recent}]
        machines["preview-3"] = None
        machines["preview-4"][0]["state"] = "stopped"
        _, removed = self.reclaim(counts, prs, machines, resumed=("5",))
        self.assertEqual(removed, ["4", *[str(number) for number in range(6, 15)]])

    def test_checks_for_a_missed_close_and_rechecks_pr_activity(self):
        old = "2026-11-18T00:00:00Z"
        recent = "2026-11-19T13:30:00Z"
        counts = {"unrelated-app": 88, "preview-41": 1, "preview-42": 1}
        machines = {"preview-41": [{"id": "41", "state": "suspended", "updated_at": old}]}
        latest = {
            41: {"state": "closed", "updated_at": recent},
            42: {"state": "open", "updated_at": recent},
        }
        self.assertEqual(self.reclaim(counts, [(42, old)], machines, latest=latest), (3, ["41"]))


if __name__ == "__main__":
    unittest.main()
