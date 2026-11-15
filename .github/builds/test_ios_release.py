import datetime
import hashlib
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("ios_release", Path(__file__).with_name("build-ios-release.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ProfileValidation(unittest.TestCase):
    def setUp(self):
        self.now = datetime.datetime(2026, 1, 1)
        self.identity = hashlib.sha1(b"fake certificate").hexdigest().upper()
        self.profile = {
            "Entitlements": {"application-identifier": "PREFIX.work.example.bot", "get-task-allow": False},
            "TeamIdentifier": ["FAKETEAM"],
            "DeveloperCertificates": [b"fake certificate"],
            "ExpirationDate": self.now + datetime.timedelta(days=1),
        }

    def check_profile(self):
        module.validate_profile(self.profile, "work.example.bot", "FAKETEAM", self.identity, self.now)

    def test_matching_distribution_profile(self):
        self.check_profile()

    def test_rejects_other_app_team_certificate_and_expired_profiles(self):
        for key, value in [
            ("Entitlements", {"application-identifier": "PREFIX.work.example.other"}),
            ("TeamIdentifier", ["OTHERTEAM"]),
            ("DeveloperCertificates", [b"another certificate"]),
            ("ExpirationDate", self.now),
        ]:
            with self.subTest(key=key):
                original = self.profile[key]
                self.profile[key] = value
                with self.assertRaises(ValueError):
                    self.check_profile()
                self.profile[key] = original

    def test_rejects_device_profiles_and_development_signing(self):
        for key in ["ProvisionedDevices", "ProvisionsAllDevices"]:
            self.profile[key] = True
            with self.assertRaises(ValueError):
                self.check_profile()
            del self.profile[key]
        self.profile["Entitlements"]["get-task-allow"] = True
        with self.assertRaises(ValueError):
            self.check_profile()


if __name__ == "__main__":
    unittest.main()
