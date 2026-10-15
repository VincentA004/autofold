"""Durable, run-scoped remote worker control. Receipts never establish a score."""
from __future__ import annotations

import argparse
import hashlib
import ctypes
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import uuid


# Remote scientific children receive only host runtime paths, deterministic
# locale/temp settings, device visibility, compiler/library paths and caches.
# Deliberately absent: provider/cloud credentials, SSH agents, PYTHONPATH,
# LD_PRELOAD and every unknown inherited variable. This does not alter the
# local SSH controller's authentication environment.
WORKER_INHERITED_ENVIRONMENT = frozenset({
    "PATH", "HOME", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_MESSAGES",
    "LC_COLLATE", "LC_NUMERIC", "LC_TIME", "LC_MONETARY", "LC_ADDRESS",
    "LC_IDENTIFICATION", "LC_MEASUREMENT", "LC_NAME", "LC_PAPER", "LC_TELEPHONE", "TZ",
    "TMPDIR", "TMP", "TEMP", "VIRTUAL_ENV", "CONDA_PREFIX",
    "LD_LIBRARY_PATH", "LIBRARY_PATH", "DYLD_LIBRARY_PATH", "DYLD_FALLBACK_LIBRARY_PATH",
    "CPATH", "C_INCLUDE_PATH", "CPLUS_INCLUDE_PATH", "CC", "CXX", "CMAKE_PREFIX_PATH",
    "CUDA_HOME", "CUDA_PATH", "CUDA_VISIBLE_DEVICES", "CUDA_DEVICE_ORDER",
    "NVIDIA_VISIBLE_DEVICES", "NVIDIA_DRIVER_CAPABILITIES", "CUDA_MODULE_LOADING",
    "CUDA_CACHE_PATH", "CUDA_CACHE_MAXSIZE", "CUDA_LAUNCH_BLOCKING",
    "OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS",
    "VECLIB_MAXIMUM_THREADS", "PYTORCH_CUDA_ALLOC_CONF", "PYTORCH_ALLOC_CONF",
    "TORCH_HOME", "TORCH_EXTENSIONS_DIR", "HF_HOME", "HF_HUB_CACHE", "HUGGINGFACE_HUB_CACHE",
    "TRANSFORMERS_CACHE", "HF_DATASETS_CACHE", "XDG_CACHE_HOME",
    "HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_DATASETS_OFFLINE",
    "HF_HUB_DISABLE_TELEMETRY", "HF_HUB_DISABLE_PROGRESS_BARS", "PYTHONHASHSEED",
    "PROTO_HOME", "AUTOFOLD_PROTO_ROOT", "AUTOFOLD_BOLTZGEN_EXECUTABLE",
    "AUTOFOLD_BOLTZGEN_CACHE", "AUTOFOLD_PXDESIGN_EXECUTABLE",
})
PLAN_ENVIRONMENT = frozenset({
    "PROTO_HOME", "AUTOFOLD_PROTO_ROOT", "AUTOFOLD_BOLTZGEN_EXECUTABLE",
    "AUTOFOLD_BOLTZGEN_CACHE", "AUTOFOLD_PXDESIGN_EXECUTABLE",
})


def validated_plan_environment(plan: dict) -> dict[str, str]:
    if "freezeRuntimeEnvironment" in plan and type(plan["freezeRuntimeEnvironment"]) is not bool:
        raise ValueError("Invalid frozen runtime environment flag")
    environment = plan.get("environment", {})
    if not isinstance(environment, dict) or any(
        key not in PLAN_ENVIRONMENT or not isinstance(value, str) or "\0" in value or len(value.encode()) > 65536
        for key, value in environment.items()
    ):
        raise ValueError("Unsupported remote environment override")
    return environment


def worker_environment(plan: dict, inherited: dict[str, str] | None = None) -> dict[str, str]:
    inherited = os.environ if inherited is None else inherited
    environment = {key: value for key, value in inherited.items() if key in WORKER_INHERITED_ENVIRONMENT and not (plan.get("freezeRuntimeEnvironment") is True and key in PLAN_ENVIRONMENT)}
    environment.update(validated_plan_environment(plan))
    environment.update({"PYTHONDONTWRITEBYTECODE": "1", "PYTHONUNBUFFERED": "1", "PYTHONNOUSERSITE": "1", "PROTO_NO_SPINNER": "1", "TQDM_DISABLE": "1"})
    return environment


def atomic_json(file: Path, value: dict) -> None:
    temporary = file.with_name(file.name + "." + uuid.uuid4().hex + ".tmp")
    with temporary.open("x", encoding="utf-8") as handle:
        json.dump(value, handle, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, file)
    fd = os.open(file.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def worker_hash(root: Path) -> str:
    files = [root / "run_worker.py"] + [p for p in (root / "autofold_worker").rglob("*.py") if "__pycache__" not in p.parts]
    digest = hashlib.sha256()
    for file in sorted(files, key=lambda p: p.relative_to(root).as_posix()):
        if file.is_symlink() or not file.is_file():
            raise ValueError("Remote worker source is not a regular file")
        digest.update(file.relative_to(root).as_posix().encode())
        digest.update(b"\0")
        digest.update(file.read_bytes())
        digest.update(b"\0")
    return "sha256:" + digest.hexdigest()


def load(directory: str, bundle_hash: str, source_hash: str, expected_plan_hash: str | None = None) -> tuple[Path, dict]:
    lexical = Path(directory).absolute()
    root = lexical.resolve(strict=True)
    if lexical != root or root.is_symlink():
        raise ValueError("Remote run path traverses a symbolic link")
    bundle_file = root / "bundle.json"
    if bundle_file.is_symlink() or "sha256:" + hashlib.sha256(bundle_file.read_bytes()).hexdigest() != bundle_hash:
        raise ValueError("Remote frozen bundle hash differs")
    if worker_hash(root / "worker") != source_hash:
        raise ValueError("Remote worker source hash differs")
    plan = json.loads((root / "remote-plan.json").read_text())
    bundle = json.loads(bundle_file.read_text())
    if plan.get("format") not in ("autofold.remote-plan.v1", "autofold.local-plan.v1") or plan.get("runId") != bundle.get("runId"):
        raise ValueError("Remote plan belongs to another run")
    if plan.get("bundleHash") != bundle_hash or plan.get("workerHash") != source_hash:
        raise ValueError("Remote plan differs from launch identity")
    if not isinstance(plan.get("timeoutMs"), int) or not 1 <= plan["timeoutMs"] <= 2**53 - 1:
        raise ValueError("Invalid remote wall-time deadline")
    argv = plan.get("argv")
    if not isinstance(argv, list) or not argv or any(not isinstance(arg, str) or "\0" in arg for arg in argv):
        raise ValueError("Invalid host worker command")
    if plan.get("format") == "autofold.local-plan.v1":
        cwd = Path(plan.get("workingDirectory", "")).resolve(strict=True)
        output = Path(plan.get("outputPath", "")).resolve()
        if not cwd.is_dir() or not output.is_relative_to(cwd):
            raise ValueError("Local process plan escapes its host workspace")
    elif len(argv) not in (8, 10) or argv[1] != str(root / "worker/run_worker.py"):
        raise ValueError("Remote command is not the staged scientific worker")
    if plan.get("format") != "autofold.local-plan.v1" and argv[2:6] != ["--bundle", str(bundle_file), "--output", str(root / "output")]:
        raise ValueError("Remote command escapes its frozen run")
    for flag, file in zip(argv[6::2], argv[7::2]) if plan.get("format") != "autofold.local-plan.v1" else []:
        if flag not in ("--evaluator-source", "--evidence-adapter-source") or Path(file).parent != root / "worker/autofold_worker":
            raise ValueError("Invalid frozen evaluator path")
    validated_plan_environment(plan)
    if expected_plan_hash is not None and plan_hash(plan) != expected_plan_hash:
        raise ValueError("Frozen process plan hash differs")
    prior = receipt(root)
    if prior and prior.get("planHash") and prior["planHash"] != plan_hash(plan):
        raise ValueError("Recorded process plan identity differs")
    return root, plan


def receipt(root: Path) -> dict | None:
    file = root / "remote-receipt.json"
    if not file.exists():
        return None
    return json.loads(file.read_text())


def plan_hash(plan: dict) -> str:
    return "sha256:" + hashlib.sha256(json.dumps(plan, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def identity(plan: dict) -> dict:
    return {**{key: plan[key] for key in ("runId", "bundleHash", "workerHash")}, "planHash": plan_hash(plan)}



def launch(root: Path, plan: dict) -> dict:
    observed = original_status(root, plan)
    if observed.get("state") != "absent":
        if any(observed.get(key) != item for key, item in identity(plan).items()):
            raise ValueError("Existing original process identity differs")
        return observed
    if (root / "watchdog-launch.json").exists() or (root / "process-launch.json").exists():
        return {**identity(plan), "state": "launching", "effectState": "unresolved"}
    file = root / "remote-receipt.json"
    accepted_at = time.time()
    deadline = accepted_at + plan["timeoutMs"] / 1000
    if plan.get("authorizationDeadlineMs") is not None:
        grant = plan["authorizationDeadlineMs"]
        if not isinstance(grant, (int, float)) or not 0 < grant < float("inf"):
            raise ValueError("Invalid original process authorization deadline")
        deadline = min(deadline, grant / 1000)
    initial = {"format": "autofold.remote-receipt.v1", **identity(plan), "state": "launching", "recordedAt": accepted_at,
        "boot": boot_identity(), "deadlineAt": deadline, "deadlineMonotonic": time.monotonic() + max(0, deadline - accepted_at)}
    try:
        fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        previous = receipt(root)
        if previous is None or any(previous.get(key) != value for key, value in identity(plan).items()):
            raise ValueError("Existing remote receipt has a different identity")
        return previous
    with os.fdopen(fd, "w") as handle:
        json.dump(initial, handle)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    directory_fd = os.open(root, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
    # An interrupted launching receipt remains uncertain and is never relaunched.
    with (root / "remote-controller.log").open("ab") as log:
        subprocess.Popen([sys.executable, __file__, "execute", "--directory", str(root), "--bundle-hash", plan["bundleHash"], "--worker-hash", plan["workerHash"]], stdin=subprocess.DEVNULL, stdout=log, stderr=log, env=worker_environment(plan), start_new_session=True, close_fds=True)
    return receipt(root) or initial


def boot_identity() -> str:
    if sys.platform.startswith("linux"):
        return Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    if sys.platform == "darwin":
        return subprocess.check_output(["sysctl", "-n", "kern.boottime"], text=True).strip()
    raise ValueError("Platform lacks a strong process boot identity")


class BsdInfo(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint32) for name in ("flags", "status", "xstatus", "pid", "ppid", "uid", "gid", "ruid", "rgid", "svuid", "svgid", "reserved")] + [
        ("comm", ctypes.c_char * 16), ("name", ctypes.c_char * 32),
    ] + [(name, ctypes.c_uint32) for name in ("nfiles", "pgid", "jobc", "tdev", "tpgid", "nice")] + [("start_sec", ctypes.c_uint64), ("start_usec", ctypes.c_uint64)]


def process_identity(pid: int) -> dict | None:
    """PID is never authority: bind boot and kernel process birth identity."""
    try:
        if sys.platform.startswith("linux"):
            fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
            return {"pid": pid, "boot": boot_identity(), "birth": fields[19], "live": fields[0] != "Z"}
        if sys.platform == "darwin":
            value = BsdInfo()
            library = ctypes.CDLL("/usr/lib/libproc.dylib")
            size = library.proc_pidinfo(pid, 3, 0, ctypes.byref(value), ctypes.sizeof(value))
            if size != ctypes.sizeof(value):
                return None
            return {"pid": pid, "boot": boot_identity(), "birth": f"{value.start_sec}:{value.start_usec}", "live": value.status != 5}
        raise ValueError("Platform lacks a strong process birth identity")
    except (FileNotFoundError, ProcessLookupError, PermissionError):
        return None


def process_matches(expected: dict | None) -> bool:
    if not expected or not isinstance(expected.get("pid"), int):
        return False
    actual = process_identity(expected["pid"])
    return bool(actual and actual["live"] and all(actual.get(key) == expected.get(key) for key in ("pid", "boot", "birth")))


def stop_original(expected: dict) -> bool:
    if not process_matches(expected):
        return True
    rows = subprocess.check_output(["ps", "-axo", "pid=,ppid="], text=True).splitlines()
    pairs = [tuple(map(int, row.split())) for row in rows if len(row.split()) == 2]
    observed = {expected["pid"]}
    for _ in range(len(pairs) + 1):
        descendants = {pid for pid, parent in pairs if parent in observed}
        if descendants <= observed:
            break
        observed.update(descendants)
    identities = [item for pid in observed if (item := process_identity(pid)) and item["live"]]
    # The original birth is checked again after inventory and before signaling.
    if not process_matches(expected):
        return True
    for name in (signal.SIGTERM, signal.SIGKILL):
        for item in reversed(identities):
            if not process_matches(item):
                continue
            try:
                if os.getpgid(item["pid"]) == item["pid"]:
                    os.killpg(item["pid"], name)
                os.kill(item["pid"], name)
            except (ProcessLookupError, PermissionError):
                pass
        end = time.monotonic() + 1
        while time.monotonic() < end and any(process_matches(item) for item in identities):
            time.sleep(.02)
    return not any(process_matches(item) for item in identities)


def command(action: str, root: Path, plan: dict) -> list[str]:
    return [sys.executable, __file__, action, "--directory", str(root), "--bundle-hash", plan["bundleHash"], "--worker-hash", plan["workerHash"], "--plan-hash", plan_hash(plan)]


def spawn_control(action: str, root: Path, plan: dict) -> subprocess.Popen:
    with (root / "remote-controller.log").open("ab") as log:
        return subprocess.Popen(command(action, root, plan), stdin=subprocess.DEVNULL, stdout=log, stderr=log,
            env=worker_environment(plan), start_new_session=True, close_fds=True)


def execute(root: Path, plan: dict) -> dict:
    """Launch controller has no worker lifetime authority. Watchdog survives it."""
    previous = receipt(root)
    if previous is None or previous.get("state") != "launching":
        raise ValueError("Remote execution lacks a fresh launch intent")
    try:
        fd = os.open(root / "watchdog-launch.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return receipt(root) or previous
    with os.fdopen(fd, "w") as handle:
        json.dump({**identity(plan), "controller": process_identity(os.getpid())}, handle)
        handle.flush(); os.fsync(handle.fileno())
    directory_fd = os.open(root, os.O_RDONLY)
    try: os.fsync(directory_fd)
    finally: os.close(directory_fd)
    watcher = spawn_control("watch", root, plan)
    watcher.wait()
    return receipt(root) or previous


def registry(root: Path, plan: dict) -> dict | None:
    try:
        value = json.loads((root / "process-registry.json").read_text())
    except FileNotFoundError:
        return None
    if any(value.get(key) != item for key, item in identity(plan).items()):
        raise ValueError("Original process registry identity differs")
    return value


def watch(root: Path, plan: dict, adopt: bool = False) -> dict:
    with (root / "watchdog.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return receipt(root) or {**identity(plan), "state": "absent"}
        atomic_json(root / "watchdog-owner.json", {**identity(plan), "watchdog": process_identity(os.getpid())})
        original = registry(root, plan)
        if not adopt:
            # Permanent launch fence: neither another watcher nor adoption may
            # start a second scientific process after any ambiguous spawn.
            try:
                fd = os.open(root / "process-launch.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                return receipt(root) or {**identity(plan), "state": "launching"}
            with os.fdopen(fd, "w") as handle:
                json.dump(identity(plan), handle); handle.flush(); os.fsync(handle.fileno())
            directory_fd = os.open(root, os.O_RDONLY)
            try: os.fsync(directory_fd)
            finally: os.close(directory_fd)
            spawn_control("run", root, plan)
        while True:
            final = receipt(root)
            if final and final.get("state") in ("succeeded", "failed", "cancelled", "timed_out"):
                return final
            original = registry(root, plan)
            if original is None:
                if adopt:
                    return {**identity(plan), "state": "launching", "effectState": "unresolved"}
                time.sleep(.02)
                continue
            if original["boot"] != boot_identity():
                return {**identity(plan), "state": "running", "effectState": "unresolved", "detail": "Original process boot changed"}
            # The original runner normally owns exit receipt and enforces the
            # same deadline. An adopted watcher only stops its proven child.
            child = original.get("worker")
            cancelled = (root / "cancel.request").exists()
            expired = time.monotonic() >= original["deadlineMonotonic"] or time.time() >= original["deadlineAt"]
            if not process_matches(original.get("runner")):
                if child and process_matches(child) and (cancelled or expired):
                    if stop_original(child):
                        final = {**identity(plan), "state": "cancelled" if cancelled else "timed_out", "exitCode": None,
                            "completedAt": time.time(), "terminationProof": child, "adopted": True}
                        atomic_json(root / "remote-receipt.json", final)
                        return final
                elif not child or not process_matches(child):
                    # No original exit receipt: process absence does not prove
                    # successful execution, even if a manifest is present.
                    return {**identity(plan), "state": "running", "effectState": "unresolved", "detail": "Original exit receipt is unavailable"}
            time.sleep(.02)


def run_original(root: Path, plan: dict) -> dict:
    previous = receipt(root)
    if previous is None or previous.get("state") != "launching":
        raise ValueError("Scientific runner lacks its original launch intent")
    with (root / "runner.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("Original runner already owns this process")
        if registry(root, plan) is not None:
            raise ValueError("Original scientific process cannot be relaunched")
        interrupted = False
        def request_stop(_signal, _frame):
            nonlocal interrupted
            interrupted = True
        signal.signal(signal.SIGTERM, request_stop); signal.signal(signal.SIGINT, request_stop)
        if previous.get("boot") != boot_identity() or not isinstance(previous.get("deadlineMonotonic"), (int, float)) or not isinstance(previous.get("deadlineAt"), (int, float)):
            raise ValueError("Original process deadline identity is unresolved")
        runner = process_identity(os.getpid())
        if not runner or not runner.get("birth"):
            raise ValueError("Original runner birth identity is unavailable")
        original = {**identity(plan), "format": "autofold.process-registry.v1", "boot": previous["boot"], "runner": runner,
            "startedAt": time.time(), "deadlineMonotonic": previous["deadlineMonotonic"], "deadlineAt": previous["deadlineAt"]}
        atomic_json(root / "process-registry.json", original)
        if interrupted or (root / "cancel.request").exists():
            final = {**identity(plan), "state": "cancelled", "exitCode": None, "completedAt": time.time()}
            atomic_json(root / "remote-receipt.json", final); return final
        if time.monotonic() >= original["deadlineMonotonic"] or time.time() >= original["deadlineAt"]:
            final = {**identity(plan), "state": "timed_out", "exitCode": None, "completedAt": time.time(), "neverStarted": True}
            atomic_json(root / "remote-receipt.json", final); return final
        with (root / "worker.log").open("ab") as log:
            child = subprocess.Popen(plan["argv"], cwd=plan.get("workingDirectory", root), env=worker_environment(plan), stdin=subprocess.DEVNULL,
                stdout=log, stderr=log, start_new_session=True)
            original["worker"] = process_identity(child.pid)
            atomic_json(root / "process-registry.json", original)
            launcher = json.loads((root / "watchdog-launch.json").read_text()).get("controller", {})
            atomic_json(root / "remote-receipt.json", {**identity(plan), "state": "running", "controllerPid": launcher.get("pid"),
                "watchdogPid": json.loads((root / "watchdog-owner.json").read_text())["watchdog"]["pid"], "runnerPid": os.getpid(), "workerPid": child.pid, "workerIdentity": original["worker"]})
            state = "running"
            while child.poll() is None:
                if interrupted or (root / "cancel.request").exists():
                    if not stop_original(original["worker"]):
                        raise ValueError("Original process termination is unresolved")
                    state = "cancelled"; break
                if time.monotonic() >= original["deadlineMonotonic"] or time.time() >= original["deadlineAt"]:
                    if not stop_original(original["worker"]):
                        raise ValueError("Original timeout termination is unresolved")
                    state = "timed_out"; break
                time.sleep(.02)
            child.wait()
            if state == "running" and (time.monotonic() >= original["deadlineMonotonic"] or time.time() >= original["deadlineAt"]):
                state = "timed_out"
            if state == "running":
                state = "succeeded" if child.returncode == 0 and (plan.get("requireManifest", True) is False or (Path(plan.get("outputPath", str(root / "output"))) / "manifest.json").is_file()) else "failed"
        final = {**identity(plan), "state": state, "exitCode": child.returncode, "completedAt": time.time()}
        atomic_json(root / "worker-exit.json", final)
        atomic_json(root / "remote-receipt.json", final)
        return final


def adopt_original(root: Path, plan: dict) -> dict:
    previous = original_status(root, plan)
    if previous and previous.get("state") in ("succeeded", "failed", "cancelled", "timed_out"):
        return previous
    original = registry(root, plan)
    if original is None or original["boot"] != boot_identity() or not any(process_matches(original.get(key)) for key in ("runner", "worker")):
        return previous or {**identity(plan), "state": "absent"}
    if process_matches(original.get("runner")):
        return previous or {**identity(plan), "state": "running"}
    with (root / "watchdog.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return previous or {**identity(plan), "state": "running"}
    # Adoption is observation/termination of the exact original identity only.
    # It has no code path that launches scientific compute.
    spawn_control("adopt-watch", root, plan)
    return previous or {**identity(plan), "state": "running"}

def original_status(root: Path, plan: dict) -> dict:
    value = receipt(root)
    if value is not None:
        return value
    try:
        final = json.loads((root / "worker-exit.json").read_text())
    except FileNotFoundError:
        final = None
    if final is not None:
        if any(final.get(key) != item for key, item in identity(plan).items()):
            raise ValueError("Original exit receipt identity differs")
        return final
    original = registry(root, plan)
    if original is not None:
        return {**identity(plan), "state": "running", "effectState": "unresolved", "registryObserved": True,
                "workerPid": original.get("worker", {}).get("pid"), "workerIdentity": original.get("worker")}
    return {**identity(plan), "state": "absent"}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("launch", "execute", "watch", "run", "adopt-watch", "adopt", "status", "cancel"))
    parser.add_argument("--directory", required=True)
    parser.add_argument("--bundle-hash", required=True)
    parser.add_argument("--worker-hash", required=True)
    parser.add_argument("--plan-hash")
    parser.add_argument("--require-cancel-ack", action="store_true", help="With cancel, require the launched controller to acknowledge termination")
    args = parser.parse_args()
    if args.require_cancel_ack and args.action != "cancel":
        parser.error("--require-cancel-ack is only valid with cancel")
    root, plan = load(args.directory, args.bundle_hash, args.worker_hash, args.plan_hash)
    if args.action == "launch":
        value = launch(root, plan)
    elif args.action == "execute":
        value = execute(root, plan)
    elif args.action in ("watch", "adopt-watch"):
        value = watch(root, plan, args.action == "adopt-watch")
    elif args.action == "run":
        value = run_original(root, plan)
    elif args.action == "adopt":
        value = adopt_original(root, plan)
    else:
        if args.action == "cancel":
            with (root / "cancel.request").open("a") as handle:
                handle.flush()
                os.fsync(handle.fileno())
            # An existing host launch attempt may still own a live worker even
            # when its remote receipt was deleted. Only that controller can
            # acknowledge actual termination; an absent receipt stays uncertain.
            if not args.require_cancel_ack:
                # Without a host launch attempt, race with launch through the
                # exclusive receipt fence and conclusively forbid first launch.
                try:
                    fd = os.open(root / "remote-receipt.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                except FileExistsError:
                    pass
                else:
                    with os.fdopen(fd, "w") as handle:
                        json.dump({**identity(plan), "state": "cancelled", "exitCode": None, "completedAt": time.time()}, handle)
                        handle.flush()
                        os.fsync(handle.fileno())
            directory_fd = os.open(root, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        value = original_status(root, plan)
        value = {**value, "manifest": (Path(plan.get("outputPath", str(root / "output"))) / "manifest.json").is_file()}
    print(json.dumps(value))


if __name__ == "__main__":
    main()
