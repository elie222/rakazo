"""Make space for a new PR preview when the Fly organization is near its Machine limit."""

import json
import os
import re
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

IDLE_STATES = {"stopped", "suspended"}


def fly_get(path):
    request = Request(
        f"https://api.machines.dev/v1/{path}",
        headers={"Authorization": f"Bearer {os.environ['FLY_API_TOKEN']}"},
    )
    with urlopen(request, timeout=15) as response:
        return json.load(response)


def updated_at(resource):
    return datetime.fromisoformat(resource["updated_at"].replace("Z", "+00:00"))


def reclaim_capacity(org, repo, prefix, deploying_pr, high_water, now):
    inventory = fly_get(f"apps?{urlencode({'org_slug': org})}")
    apps = {app["name"]: app["machine_count"] for app in inventory["apps"]}
    if len(apps) != inventory["total_apps"]:
        raise ValueError("Incomplete Fly preview organization inventory")
    total = sum(apps.values())
    if total < high_water or apps.get(f"{prefix}-{deploying_pr}", 0):
        return

    pages = subprocess.check_output(
        ["gh", "api", "--paginate", "--slurp", f"repos/{repo}/pulls?state=open&per_page=100"],
        text=True,
    )
    cutoff = now - timedelta(hours=1)
    open_prs = {pr["number"]: updated_at(pr) for page in json.loads(pages) for pr in page}
    previews = []
    for app, count in apps.items():
        match = re.fullmatch(rf"{re.escape(prefix)}-([1-9][0-9]*)", app)
        if not match or count != 1:
            continue
        number = int(match[1])
        # Check apps missing from the open list first. A fresh PR read confirms their state.
        last_update = open_prs.get(number, datetime.min.replace(tzinfo=timezone.utc))
        if number != deploying_pr and last_update <= cutoff:
            previews.append((last_update, number, app))

    removed = 0
    for _, number, app in sorted(previews):
        pr = json.loads(subprocess.check_output(
            ["gh", "api", f"repos/{repo}/pulls/{number}", "--jq", "{state, updated_at}"],
            text=True,
        ))
        if pr["state"] != "closed" and (pr["state"] != "open" or updated_at(pr) > cutoff):
            continue

        try:
            machines = fly_get(f"apps/{app}/machines")
        except HTTPError as error:
            if error.code == 404:  # Close cleanup may have removed this app.
                error.close()
                continue
            raise
        if len(machines) != 1:
            continue
        machine = machines[0]
        if machine["state"] not in IDLE_STATES or updated_at(machine) > cutoff:
            continue

        # Fly refuses a non-forced destroy if the Machine has started since the check.
        if subprocess.run(["flyctl", "machine", "destroy", machine["id"], "--app", app]).returncode:
            continue
        print(f"Reclaiming idle preview {app} ({total} Machines before cleanup).", flush=True)
        subprocess.run(
            ["bash", str(Path(__file__).with_name("cleanup.sh"))],
            env={**os.environ, "PR": str(number)},
            check=True,
        )
        removed += 1
        if removed == 10:
            break
    if not removed:
        print(f"No stale idle PR previews to reclaim ({total} Machines).")


if __name__ == "__main__":
    prefix = os.environ.get("APP_PREFIX") or "rakazo-pr"
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", prefix):
        raise ValueError("Invalid Fly preview app prefix")
    high_water = int(os.environ.get("MACHINE_HIGH_WATER") or "90")
    if high_water < 1:
        raise ValueError("Fly preview Machine threshold must be positive")
    reclaim_capacity(
        os.environ["FLY_ORG"], os.environ["REPO"], prefix, int(os.environ["PR"]),
        high_water, datetime.now(timezone.utc),
    )
