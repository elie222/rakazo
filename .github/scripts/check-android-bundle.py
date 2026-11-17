"""Reject release bundles without the optimization evidence Google Play needs."""

import json
import math
import sys
import zipfile


def check_bundle(filename):
    with zipfile.ZipFile(filename) as bundle:
        report = json.loads(bundle.read("BUNDLE-METADATA/com.android.tools/r8.json"))
        if not bundle.getinfo("BUNDLE-METADATA/com.android.tools.build.obfuscation/proguard.map").file_size:
            raise ValueError("The bundle has an empty R8 mapping file")
        if not any(name.startswith("base/dex/") and name.endswith(".dex") for name in bundle.namelist()):
            raise ValueError("The archive has no base DEX code")
    for category in ("Optimization", "Obfuscation", "Shrinking"):
        excluded = report["stats"][f"no{category}Percentage"]
        if (
            isinstance(excluded, bool)
            or not isinstance(excluded, (int, float))
            or not math.isfinite(excluded)
            or not 0 <= excluded <= 75
        ):
            raise ValueError(f"R8 {category.lower()} coverage is below 25% or invalid")
        print(f"R8 {category.lower()}: {100 - excluded:.2f}%")


if __name__ == "__main__":
    check_bundle(sys.argv[1])
