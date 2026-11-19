import json
import runpy
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

reclaim_capacity = runpy.run_path(Path(__file__).with_name("reclaim-capacity.py"))["reclaim_capacity"]
NOW = datetime(2026, 11, 19, 14, tzinfo=timezone.utc)


class ReclaimCapacityTest(unittest.TestCase):
    def reclaim(self, counts, prs, machines):
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
        with (
            patch.dict(reclaim_capacity.__globals__, fly_get=fly_get),
            patch("subprocess.check_output", return_value=json.dumps(pages)) as list_prs,
            patch("subprocess.run") as cleanup,
        ):
            reclaim_capacity("preview-org", "owner/repo", "preview", 123, 90, NOW)
        return list_prs.call_count, [call.kwargs["env"]["PR"] for call in cleanup.call_args_list]

    def test_below_threshold_or_existing_machine_skips_cleanup(self):
        self.assertEqual(self.reclaim({"other-app": 89}, [], {}), (0, []))
        self.assertEqual(self.reclaim({"other-app": 89, "preview-123": 1}, [], {}), (0, []))

    def test_reclaims_ten_oldest_eligible_previews_at_threshold(self):
        old = "2026-11-18T00:00:00Z"
        recent = "2026-11-19T13:30:00Z"
        counts = {f"preview-{number}": 1 for number in range(1, 18)}
        counts.update({"unrelated-app": 71, "preview-main": 1, "preview-123": 0, "preview-18": 1})
        prs = [(number, old) for number in reversed(range(1, 18))] + [(18, recent), (123, old)]
        machines = {f"preview-{number}": [{"state": "suspended", "updated_at": old}] for number in range(1, 18)}
        machines["preview-1"] = [{"state": "started", "updated_at": old}]
        machines["preview-2"] = [{"state": "stopped", "updated_at": recent}]
        machines["preview-3"] = None
        machines["preview-4"] = [{"state": "stopped", "updated_at": old}]
        self.assertEqual(self.reclaim(counts, prs, machines), (1, [str(number) for number in range(4, 14)]))


if __name__ == "__main__":
    unittest.main()
