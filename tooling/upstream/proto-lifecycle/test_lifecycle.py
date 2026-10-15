"""Run reviewed upstream CPU conformance against an explicitly pinned local fork."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import runpy
import sys

from prepare import verify_package


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    root = args.root.resolve()
    manifest = json.loads((Path(__file__).parent / "manifest.json").read_text())
    verify_package(root, "proto_language", manifest["patchedCommits"]["language"], manifest["packageDigests"]["proto_language"])
    verify_package(root / "proto-tools", "proto_tools", manifest["patchedCommits"]["tools"], manifest["packageDigests"]["proto_tools"])
    os.environ.update(CUDA_VISIBLE_DEVICES="", HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", PYTHONDONTWRITEBYTECODE="1")
    sys.dont_write_bytecode = True
    sys.path[:0] = [str(root), str(root / "proto-tools")]
    fixture = root / "tests/language_tests/test_execution_lifecycle.py"
    if "sha256:" + hashlib.sha256(fixture.read_bytes()).hexdigest() != manifest["conformanceFixtureHash"]:
        raise ValueError("Reviewed conformance fixture changed")
    sys.argv = [str(fixture)]
    runpy.run_path(str(fixture), run_name="__main__")


if __name__ == "__main__":
    main()
