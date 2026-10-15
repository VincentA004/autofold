"""Reproduce the reviewed local Proto fork without editing either original tree.

No installs, remote operations, models, providers or GPU execution. Destination
must be a fresh directory. Commit metadata is fixed solely for reproducible
source identity; it does not represent scientific execution authority.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parent


def git(directory: Path, *args: str, env=None) -> str:
    return subprocess.check_output(["git", "-C", str(directory), *args], text=True, env=env).strip()


def verify_package(directory: Path, package: str, commit: str, expected_digest: str | None = None) -> str:
    if git(directory, "rev-parse", "HEAD") != commit:
        raise ValueError(f"Pinned {package} commit differs")
    if git(directory, "status", "--porcelain", "--", package):
        raise ValueError(f"Pinned {package} executable tree is dirty")
    if any(name.endswith(".py") for name in git(directory, "ls-files", "--others", "--", package).splitlines()):
        raise ValueError(f"Pinned {package} has untracked executable Python")
    digest = hashlib.sha256()
    for relative in git(directory, "ls-files", package).splitlines():
        if relative.endswith(".py"):
            digest.update(relative.encode() + b"\0" + (directory / relative).read_bytes() + b"\0")
    result = "sha256:" + digest.hexdigest()
    if expected_digest is not None and result != expected_digest:
        raise ValueError(f"Pinned {package} executable digest differs")
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True, help="Read-only original Proto checkout")
    parser.add_argument("--destination", type=Path, required=True, help="Fresh local fork directory")
    args = parser.parse_args()
    source, destination = args.source.resolve(), args.destination.resolve()
    manifest = json.loads((HERE / "manifest.json").read_text())
    if destination.exists():
        raise ValueError("Destination already exists; refusing overwrite/reset")
    original = {
        "language": verify_package(source, "proto_language", manifest["bases"]["language"]),
        "tools": verify_package(source / "proto-tools", "proto_tools", manifest["bases"]["tools"]),
    }
    for name, expected in manifest["patches"].items():
        if "sha256:" + hashlib.sha256((HERE / name).read_bytes()).hexdigest() != expected:
            raise ValueError(f"Reviewed patch changed: {name}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "clone", "--no-hardlinks", "--quiet", str(source), str(destination)], check=True)
    subprocess.run(["git", "clone", "--no-hardlinks", "--quiet", str(source / "proto-tools"), str(destination / "proto-tools")], check=True)
    identity = manifest["commitIdentity"]
    commit_env = os.environ.copy()
    commit_env.update(GIT_AUTHOR_DATE=identity["date"], GIT_COMMITTER_DATE=identity["date"])
    stages = [(destination / "proto-tools", "proto-tools.patch", "tools", "proto_tools"),
              (destination, "proto-language.patch", "language", "proto_language")]
    for directory, patch_name, kind, package in stages:
        git(directory, "checkout", "--quiet", manifest["bases"][kind])
        git(directory, "apply", "--check", str(HERE / patch_name))
        git(directory, "apply", str(HERE / patch_name))
        git(directory, "add", "--all")
        # Language's gitlink records the newly committed tools dependency.
        if kind == "language":
            git(directory, "add", "proto-tools")
        git(directory, "-c", "user.name=" + identity["name"], "-c", "user.email=" + identity["email"],
            "commit", "--quiet", "-m", manifest["commitMessages"][kind], env=commit_env)
        verify_package(directory, package, manifest["patchedCommits"][kind], manifest["packageDigests"][package])
    if original["language"] != verify_package(source, "proto_language", manifest["bases"]["language"]) or original["tools"] != verify_package(source / "proto-tools", "proto_tools", manifest["bases"]["tools"]):
        raise ValueError("Original pinned sources changed during preparation")
    (destination.parent / (destination.name + "-manifest.json")).write_text(json.dumps({**manifest, "root": str(destination), "originalSourceUnchanged": True}, indent=2) + "\n")
    print(json.dumps({"root": str(destination), "commits": manifest["patchedCommits"], "originalSourceUnchanged": True}))


if __name__ == "__main__":
    main()
