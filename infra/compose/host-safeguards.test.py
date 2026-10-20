#!/usr/bin/env python3
"""Offline tests; all state, firewall commands and alert delivery are isolated."""

import concurrent.futures
import contextlib
import fcntl
import importlib.util
import io
import json
import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("host_alert", ROOT / "host-alert.py")
alerts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(alerts)


class AlertTests(unittest.TestCase):
    def test_change_dedup_recovery_and_failed_delivery(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "config.json"
            config.write_text(
                json.dumps(
                    {"slack_webhook": "https://hooks.slack.com/services/example"}
                )
            )
            response = MagicMock()
            response.__enter__.return_value.status = 200
            response.__enter__.return_value.read.return_value = b"ok"
            with patch.object(
                alerts.urllib.request, "urlopen", return_value=response
            ) as send:
                emit = lambda text: alerts.notify("disk", text, config, root / "state")
                emit("")
                self.assertEqual(send.call_count, 0)
                emit("Disk full")
                emit("Disk full")
                self.assertEqual(send.call_count, 1)
                emit("")
                self.assertEqual(send.call_count, 2)
                emit("")
                self.assertEqual(send.call_count, 2)
                send.side_effect = OSError("offline")
                with self.assertRaises(OSError):
                    emit("Backup failed")
                send.side_effect = None
                emit("Backup failed")
                self.assertEqual(send.call_count, 4)

    def test_missing_webhook_uses_journal_without_network(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with (
                patch.object(alerts.urllib.request, "urlopen") as send,
                contextlib.redirect_stdout(io.StringIO()) as output,
            ):
                alerts.notify("disk", "Low space", root / "absent.json", root / "state")
                alerts.notify("disk", "Low space", root / "absent.json", root / "state")
                self.assertEqual(output.getvalue().count("Rakazo alert: Low space"), 1)
                send.assert_not_called()

    def test_concurrent_calls_deliver_once(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            response = MagicMock()
            response.__enter__.return_value.status = 200
            response.__enter__.return_value.read.return_value = b"ok"
            config = root / "config.json"
            config.write_text(
                json.dumps(
                    {"slack_webhook": "https://hooks.slack.com/services/example"}
                )
            )

            def slow_send(*args, **kwargs):
                time.sleep(0.05)
                return response

            with patch.object(
                alerts.urllib.request, "urlopen", side_effect=slow_send
            ) as send:
                with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                    list(
                        pool.map(
                            lambda _: alerts.notify(
                                "disk", "Low space", config, root / "state"
                            ),
                            range(4),
                        )
                    )
                self.assertEqual(send.call_count, 1)
                self.assertEqual(list((root / "state").glob("*.tmp")), [])

    def test_daily_reminder(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "config.json"
            config.write_text(
                json.dumps(
                    {"slack_webhook": "https://hooks.slack.com/services/example"}
                )
            )
            response = MagicMock()
            response.__enter__.return_value.status = 200
            response.__enter__.return_value.read.return_value = b"ok"
            with patch.object(
                alerts.urllib.request, "urlopen", return_value=response
            ) as send:
                with patch.object(alerts.time, "time", return_value=100000):
                    alerts.notify("disk", "Low space", config, root / "state")
                with patch.object(alerts.time, "time", return_value=186401):
                    alerts.notify("disk", "Low space", config, root / "state")
                self.assertEqual(send.call_count, 2)


class FirewallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.etc = self.root / "etc"
        (self.etc / "ufw").mkdir(parents=True)
        (self.etc / "default").mkdir()
        self.defaults = self.etc / "default/ufw"
        self.defaults.write_text('DEFAULT_OUTPUT_POLICY="DROP"\n')
        self.rules = self.etc / "ufw/user.rules"
        self.rules.write_text("original rules\n")
        self.state = self.root / "state"
        self.bin = self.root / "bin"
        self.bin.mkdir()
        for name, script in {
            "df": 'printf "Filesystem Blocks Used Available Capacity Mounted\\n/dev/fake 1000000 0 ${FAKE_FREE:-900000} 0%% /\\n"',
            "systemd-run": 'test "${FAIL_SCHEDULE:-0}" != 1 && test ! -e "$TIMER_STATE" && touch "$TIMER_STATE"',
            "systemctl": 'if [[ "$1" == show ]]; then [[ "${FAIL_SHOW:-0}" != 1 ]] || exit 1; echo "${TIMER_STATUS:-active}"; elif [[ "$1" == stop ]]; then [[ "${FAIL_STOP:-0}" != 1 ]] || exit 1; rm -f "$TIMER_STATE"; fi',
            "ufw": 'echo "$*" >> "$UFW_LOG"; if [[ "$1" == status && "${WAS_ENABLED:-1}" == 1 ]]; then echo "Status: active"; elif [[ "$1" == status ]]; then echo "Status: inactive"; fi',
            "logger": "exit 0",
        }.items():
            executable = self.bin / name
            executable.write_text("#!/bin/bash\n" + script + "\n")
            executable.chmod(0o755)
        source = (ROOT / "firewall-change.sh").read_text()
        source = source.replace('[[ "${EUID}" == 0 ]]', "true")
        source = source.replace(
            "STATE=/var/lib/rakazo/firewall-change", "STATE=" + str(self.state)
        )
        source = source.replace("df -Pk /etc/ufw", "df -Pk " + str(self.etc / "ufw"))
        source = source.replace("-C /etc", "-C " + str(self.etc))
        self.script = self.root / "firewall-change"
        self.script.write_text(source)
        self.script.chmod(0o755)
        self.env = {
            **os.environ,
            "PATH": str(self.bin) + ":" + os.environ["PATH"],
            "SSH_CONNECTION": "client 1 server 22",
            "UFW_LOG": str(self.root / "ufw.log"),
            "TIMER_STATE": str(self.root / "timer"),
        }

    def run_guard(self, *args, **env):
        return subprocess.run(
            [str(self.script), *args],
            env={**self.env, **env},
            capture_output=True,
            text=True,
        )

    def apply(self):
        result = self.run_guard(
            "apply", "bash", "-c", 'echo changed > "$1"', "_", str(self.rules)
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return (self.state / "token").read_text().strip()

    def test_requires_fresh_ssh_connection(self):
        token = self.apply()
        self.assertNotEqual(self.run_guard("confirm", token).returncode, 0)
        self.assertEqual(
            self.run_guard(
                "confirm", token, SSH_CONNECTION="client 2 server 22"
            ).returncode,
            0,
        )
        self.assertFalse((self.state / "token").exists())
        self.assertEqual(self.rules.read_text(), "changed\n")

    def test_rollback_restores_rules_and_rejects_wrong_token(self):
        token = self.apply()
        self.defaults.write_text('DEFAULT_OUTPUT_POLICY="ACCEPT"\n')
        self.assertNotEqual(self.run_guard("rollback", "wrong-token").returncode, 0)
        result = self.run_guard("rollback", token)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.rules.read_text(), "original rules\n")
        self.assertEqual(self.defaults.read_text(), 'DEFAULT_OUTPUT_POLICY="DROP"\n')
        self.assertFalse((self.state / "token").exists())

    def test_apply_requires_connection_identity(self):
        result = self.run_guard("apply", "true", SSH_CONNECTION="")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.state / "token").exists())
        self.assertFalse((self.root / "timer").exists())

    def test_rollback_waits_for_operation_lock(self):
        token = self.apply()
        with (self.state / "lock").open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            process = subprocess.Popen(
                [str(self.script), "rollback", token],
                env=self.env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            try:
                time.sleep(0.15)
                self.assertIsNone(process.poll())
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)
            _, stderr = process.communicate(timeout=5)
            self.assertEqual(process.returncode, 0, stderr)
        self.assertEqual(self.rules.read_text(), "original rules\n")

    def test_failed_timer_cleanup_preserves_pending_token(self):
        token = self.apply()
        for overrides in ({"TIMER_STATUS": "active"}, {"FAIL_SHOW": "1"}):
            result = self.run_guard("rollback", token, FAIL_STOP="1", **overrides)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual((self.state / "token").read_text().strip(), token)
            self.assertNotEqual(self.run_guard("apply", "true").returncode, 0)
        self.assertEqual(self.run_guard("rollback", token).returncode, 0)
        self.assertFalse((self.state / "token").exists())

    def test_failed_stop_with_known_inactive_timer_allows_cleanup(self):
        token = self.apply()
        result = self.run_guard(
            "rollback", token, FAIL_STOP="1", TIMER_STATUS="inactive"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.state / "token").exists())

    def test_hardening_rejects_missing_identity_before_host_changes(self):
        source = (
            (ROOT / "harden-host.sh")
            .read_text()
            .replace('[[ "${EUID}" -ne 0 ]]', "false")
        )
        script = self.root / "harden-host"
        script.write_text(source)
        result = subprocess.run(
            ["bash", str(script)],
            env={**self.env, "SSH_CONNECTION": ""},
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("SSH_CONNECTION is required", result.stderr)
        self.assertNotIn("Deploy user", result.stderr)
        self.assertEqual(result.stdout, "")

    def test_manual_rollback_allows_another_guarded_change(self):
        first = self.apply()
        self.assertEqual(self.run_guard("rollback", first).returncode, 0)
        second = self.apply()
        self.assertEqual(self.run_guard("rollback", second).returncode, 0)

    def test_rollback_restores_disabled_state(self):
        self.env["WAS_ENABLED"] = "0"
        token = self.apply()
        self.assertEqual(self.run_guard("rollback", token).returncode, 0)
        self.assertIn("--force disable", (self.root / "ufw.log").read_text())

    def test_no_edit_when_timer_cannot_be_scheduled(self):
        result = self.run_guard(
            "apply",
            "bash",
            "-c",
            'echo unsafe > "$1"',
            "_",
            str(self.rules),
            FAIL_SCHEDULE="1",
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.rules.read_text(), "original rules\n")

    def test_refuses_full_disk_and_overlapping_changes(self):
        self.assertNotEqual(
            self.run_guard("apply", "true", FAKE_FREE="1").returncode, 0
        )
        self.apply()
        self.assertNotEqual(self.run_guard("apply", "true").returncode, 0)


class HostCheckTests(unittest.TestCase):
    def test_missing_backup_directory_still_sends_alert_and_custom_port_is_used(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bin_dir = root / "bin"
            bin_dir.mkdir()
            backups = root / "backups"
            backups.mkdir()
            rules = root / "user.rules"
            rules.write_text(
                "### tuple ### limit tcp 2222 0.0.0.0/0 any 0.0.0.0/0 in\n"
            )
            alert_log = root / "alert.log"
            commands = {
                "df": 'echo "Filesystem Blocks Used Available Capacity Mounted"; echo "/dev/fake 100000000 0 40000000 20% /"',
                "mountpoint": "exit 0",
                "stat": 'if [[ "$3" == / ]]; then echo 1; else echo 2; fi',
                "systemctl": "exit 1",
                "sshd": 'echo "port 2222"',
                "alert": 'echo "$*" >> "$ALERT_LOG"; if (($# < 2)); then cat >> "$ALERT_LOG"; fi',
            }
            for name, command in commands.items():
                executable = bin_dir / name
                executable.write_text("#!/bin/bash\n" + command + "\n")
                executable.chmod(0o755)
            source = (ROOT / "check-host.sh").read_text()
            source = source.replace("/var/backups", str(backups))
            source = source.replace("/etc/ufw/user.rules", str(rules))
            source = source.replace("/usr/sbin/sshd", str(bin_dir / "sshd"))
            source = source.replace(
                "/usr/local/sbin/rakazo-host-alert", str(bin_dir / "alert")
            )
            script = root / "check.sh"
            script.write_text(source)
            env = {
                **os.environ,
                "PATH": str(bin_dir) + ":" + os.environ["PATH"],
                "ALERT_LOG": str(alert_log),
            }
            result = subprocess.run(
                ["bash", str(script)], env=env, capture_output=True, text=True
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("No verified backup completed", alert_log.read_text())
            self.assertNotIn("SSH allow rule is missing", alert_log.read_text())
            (backups / "rakazo" / "20261020T000000Z").mkdir(parents=True)
            (backups / "rakazo" / "20261020T000000Z" / "SHA256SUMS").write_text(
                "verified"
            )
            result = subprocess.run(
                ["bash", str(script)], env=env, capture_output=True, text=True
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            rules.write_text(
                "### tuple ### allow any 2222 0.0.0.0/0 any 0.0.0.0/0 in\n"
            )
            result = subprocess.run(
                ["bash", str(script)], env=env, capture_output=True, text=True
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            # A failed recovery delivery must not skip subsequent checks or their alert.
            alert = bin_dir / "alert"
            original_alert = alert.read_text()
            alert.write_text(original_alert + '\n[[ "$1" != backup-failure ]]\n')
            rules.write_text("")
            alert_log.write_text("")
            result = subprocess.run(
                ["bash", str(script)], env=env, capture_output=True, text=True
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(
                "Could not deliver backup recovery notification", alert_log.read_text()
            )
            self.assertIn("SSH allow rule is missing", alert_log.read_text())
            alert.write_text(original_alert)
            rules.write_text(
                "### tuple ### allow any 2222 0.0.0.0/0 any 0.0.0.0/0 in\n"
            )
            (bin_dir / "mountpoint").write_text("#!/bin/bash\nexit 1\n")
            result = subprocess.run(
                ["bash", str(script)], env=env, capture_output=True, text=True
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            result = subprocess.run(
                ["bash", str(script)],
                env={**env, "RAKAZO_BACKUP_REQUIRE_VOLUME": "1"},
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(
                "Backup volume is not mounted separately", alert_log.read_text()
            )
            (bin_dir / "sshd").write_text("#!/bin/bash\nexit 1\n")
            (bin_dir / "df").write_text("#!/bin/bash\nexit 1\n")
            result = subprocess.run(
                ["bash", str(script)], env=env, capture_output=True, text=True
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Could not inspect storage", alert_log.read_text())
            self.assertIn("Could not inspect SSH configuration", alert_log.read_text())


if __name__ == "__main__":
    unittest.main()
