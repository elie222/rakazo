"""Sign the generated iOS targets with isolated, temporary CI credentials."""

import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import secrets
import shlex
import shutil
import subprocess
import sys
import tempfile


def mask(value):
    for line in str(value).splitlines():
        if line:
            print(f"::add-mask::{line}", flush=True)


def command(args):
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode:
        # security's output can contain unmasked certificate/account details.
        operation = f"{Path(args[0]).name} {Path(args[1]).name}"
        if args[:2] == ["security", "import"]:
            if "MAC verification failed" in result.stderr:
                raise RuntimeError("IOS_DISTRIBUTION_P12_BASE64 could not be unlocked: check IOS_DISTRIBUTION_P12_PASSWORD or the P12 export format")
            raise RuntimeError("IOS_DISTRIBUTION_P12_BASE64 could not be imported; export a P12 containing the distribution certificate and private key")
        raise RuntimeError(f"{operation} failed while preparing iOS signing (exit {result.returncode})")
    return result.stdout


def validate_profile(profile, bundle, team, identity, now):
    entitlement = profile["Entitlements"]
    if entitlement.get("application-identifier", "").partition(".")[2] != bundle:
        raise ValueError("Distribution profile belongs to a different application ID")
    if team not in profile.get("TeamIdentifier", []):
        raise ValueError("Distribution profile belongs to a different Apple team")
    if profile["ExpirationDate"] <= now:
        raise ValueError("Distribution profile has expired")
    if profile.get("ProvisionedDevices") or profile.get("ProvisionsAllDevices") or entitlement.get("get-task-allow"):
        raise ValueError("Use App Store Connect distribution profiles, not development or Ad Hoc profiles")
    certificates = {hashlib.sha1(cert).hexdigest().upper() for cert in profile["DeveloperCertificates"]}
    if identity not in certificates:
        raise ValueError("Distribution profile does not include the imported signing certificate")


def build(args, log):
    with log.open("w") as output:
        result = subprocess.run(["xcodebuild", *args], stdout=output, stderr=subprocess.STDOUT)
    if result.returncode:
        print("\n".join(log.read_text(errors="replace").splitlines()[-100:]), flush=True)
        raise RuntimeError("iOS build failed; see the masked build output above")


def main():
    os.umask(0o077)
    temporary = Path(tempfile.mkdtemp(prefix="botone-ios-signing-", dir=os.environ["RUNNER_TEMP"]))
    keychain = temporary / "signing.keychain-db"
    original_keychains = shlex.split(command(["security", "list-keychains", "-d", "user"]))
    installed = []
    try:
        password = secrets.token_hex(32)
        command(["security", "create-keychain", "-p", password, str(keychain)])
        command(["security", "set-keychain-settings", "-lut", "21600", str(keychain)])
        command(["security", "unlock-keychain", "-p", password, str(keychain)])
        certificate = temporary / "distribution.p12"
        certificate.write_bytes(base64.b64decode(os.environ["IOS_DISTRIBUTION_P12_BASE64"], validate=True))
        command(["security", "import", str(certificate), "-k", str(keychain), "-P", os.environ["IOS_DISTRIBUTION_P12_PASSWORD"], "-T", "/usr/bin/codesign", "-T", "/usr/bin/security"])
        command(["security", "set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-k", password, str(keychain)])
        command(["security", "list-keychains", "-d", "user", "-s", str(keychain), *original_keychains])
        identities = command(["security", "find-identity", "-v", "-p", "codesigning", str(keychain)])
        matches = re.findall(r'\b([A-F0-9]{40}) "((?:Apple Distribution|iPhone Distribution):[^"\n]+)"', identities)
        if len(matches) != 1:
            raise ValueError("P12 must contain exactly one valid distribution identity and its private key")
        identity, name = matches[0]
        mask(identity)
        mask(name)
        team = os.environ["APPLE_TEAM_ID"]
        identifier = os.environ["BOTONE_MOBILE_APP_ID"]
        profiles = {}
        for suffix, secret in [
            ("", "IOS_MAIN_PROFILE_BASE64"),
            (".widgets", "IOS_WIDGET_PROFILE_BASE64"),
            (".expo-sharing-extension", "IOS_SHARE_PROFILE_BASE64"),
            (".notifications", "IOS_NOTIFICATION_PROFILE_BASE64"),
        ]:
            encoded = temporary / f"{secret}.mobileprovision"
            encoded.write_bytes(base64.b64decode(os.environ[secret], validate=True))
            decoded = subprocess.check_output(["security", "cms", "-D", "-i", str(encoded)], stderr=subprocess.DEVNULL)
            profile = plistlib.loads(decoded)
            for value in [profile["UUID"], profile["Name"], *profile.get("TeamName", "").splitlines()]:
                mask(value)
            try:
                validate_profile(profile, identifier + suffix, team, identity, datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None))
            except ValueError as error:
                raise ValueError(f"{secret}: {error}") from None
            profiles[identifier + suffix] = profile["UUID"]
            # Current Xcode uses Developer/Xcode; retain the legacy search location too.
            for relative in ["Library/Developer/Xcode/UserData/Provisioning Profiles", "Library/MobileDevice/Provisioning Profiles"]:
                directory = Path.home() / relative
                directory.mkdir(parents=True, exist_ok=True)
                destination = directory / f'{profile["UUID"]}.mobileprovision'
                if destination.exists():
                    raise ValueError("Refusing to replace an existing provisioning profile")
                shutil.copyfile(encoded, destination)
                installed.append(destination)
        if "--validate-only" in sys.argv:
            print("Distribution certificate and all four profiles validated successfully.", flush=True)
            return
        mapping = temporary / "signing.json"
        mapping.write_text(json.dumps({"team": team, "identity": identity, "profiles": profiles}))
        command(["node", ".github/builds/configure-ios-signing.mjs", str(mapping)])
        options = temporary / "ExportOptions.plist"
        options.write_bytes(plistlib.dumps({
            "method": "app-store-connect", "destination": "export", "signingStyle": "manual",
            "teamID": team, "signingCertificate": identity, "provisioningProfiles": profiles,
            "manageAppVersionAndBuildNumber": False,
        }))
        archive = temporary / "BotONE.xcarchive"
        build(["-workspace", "apps/mobile/ios/BotONE.xcworkspace", "-scheme", "BotONE", "-configuration", "Release", "-destination", "generic/platform=iOS", "-archivePath", str(archive), "archive"], temporary / "archive.log")
        app = archive / "Products/Applications/BotONE.app"
        command(["codesign", "--verify", "--deep", "--strict", str(app)])
        if not (app / "main.jsbundle").is_file():
            raise ValueError("iOS archive is missing its bundled application code")
        output = Path(os.environ["RUNNER_TEMP"]) / "botone-ios-release"
        build(["-exportArchive", "-archivePath", str(archive), "-exportOptionsPlist", str(options), "-exportPath", str(output)], temporary / "export.log")
        if len(list(output.glob("*.ipa"))) != 1:
            raise ValueError("Expected one exported iOS IPA")
        print("Signed iOS IPA exported successfully.", flush=True)
    finally:
        subprocess.run(["security", "list-keychains", "-d", "user", "-s", *original_keychains], capture_output=True)
        subprocess.run(["security", "delete-keychain", str(keychain)], capture_output=True)
        for profile in installed:
            profile.unlink(missing_ok=True)
        shutil.rmtree(temporary, ignore_errors=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Never print a traceback or subprocess arguments containing passwords.
        print(f"::error::{error}", flush=True)
        raise SystemExit(1) from None
