"""Capture trials and commit initial assessments. No retries, queue or scientific scoring."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import socket
import subprocess
import sys
import uuid
from datetime import datetime, timezone


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write_json(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.replace(path)


def relative_path(value):
    path = Path(value)
    if not value or path.is_absolute() or ".." in path.parts or path == Path("."):
        raise ValueError(f"Expected a nonempty relative path: {value}")
    return path


def contained_file(root, value):
    path = (root / relative_path(value)).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise ValueError(f"Input must be a file inside the campaign: {value}")
    return path


def environment():
    result = {"host": socket.gethostname(), "platform": platform.platform(),
              "runner_python": sys.executable, "python_version": platform.python_version()}
    for name in ("proto_language", "proto_tools"):
        spec = importlib.util.find_spec(name)
        if spec and spec.origin:
            source = Path(spec.origin).resolve()
            revision = subprocess.run(["git", "-C", str(source.parent), "rev-parse", "HEAD"],
                                      text=True, capture_output=True)
            result[name] = {"source": str(source),
                            "commit": revision.stdout.strip() if revision.returncode == 0 else None}
    return result


def stop_process(process):
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()


def capture_runtime(campaign, directory):
    """Pin operator execution policy once; freeze implementation with each trial."""
    runtime_root = Path(__file__).resolve().parents[1] / 'runtime'
    lock = campaign / '.autofold' / 'runtime-profile.json'
    selected = os.environ.get('AUTOFOLD_RUNTIME_PROFILE')
    if selected:
        profile = json.loads(Path(selected).read_text())
    elif lock.exists():
        profile = json.loads(lock.read_text())
    else:
        profile = {'schema_version': 1, 'boltz2': {'backend': 'native'}, 'environment': {}}
    if set(profile) - {'schema_version', 'boltz2', 'alphafold2', 'rfd4', 'environment'} or profile.get('schema_version') != 1:
        raise ValueError('Unsupported infrastructure runtime profile')
    route = profile.get('boltz2', {})
    if route.get('backend') not in ('native', 'bioir'):
        raise ValueError('Runtime profile must select a qualified Boltz2 backend')
    if set(route) - {'backend','python_executable','checkpoint','checkpoint_sha256','ccd_path','mol_dir'}:
        raise ValueError('Runtime profile cannot override scientific Boltz2 parameters')
    if route['backend'] == 'bioir':
        if (any(not isinstance(route.get(k), str) or not Path(route[k]).is_absolute()
                for k in ('python_executable','checkpoint','ccd_path','mol_dir'))
                or not re.fullmatch('[a-f0-9]{64}',route.get('checkpoint_sha256',''))):
            raise ValueError('BioIR profile needs absolute installation paths and a checkpoint SHA256')
    af2 = profile.get('alphafold2', {'backend':'native'})
    if (af2.get('backend') not in ('native','bioir')
            or set(af2)-{'backend','python_executable','checkpoints','ccd_path','mol_dir'}):
        raise ValueError('Invalid infrastructure AlphaFold2 route')
    if af2['backend']=='bioir':
        if (not isinstance(af2.get('checkpoints'),dict)
                or not Path(af2.get('python_executable','')).is_absolute()):
            raise ValueError('BioIR AF2 needs provisioned converted checkpoints and runtime assets')
        for model,asset in af2['checkpoints'].items():
            if (not re.fullmatch(r'alphafold2_(multimer_)?[1-5]',model)
                    or set(asset)!={'checkpoint','checkpoint_sha256'}
                    or not Path(asset['checkpoint']).is_absolute()
                    or not re.fullmatch('[a-f0-9]{64}',asset['checkpoint_sha256'])):
                raise ValueError('Invalid converted AF2 checkpoint identity')
    rfd4 = profile.get('rfd4', {'backend':'native'})
    if rfd4.get('backend') not in ('native','bioir') or set(rfd4)-{'backend','executable','model_path'}:
        raise ValueError('Invalid infrastructure RFD4 route')
    env = profile.get('environment', {})
    allowed = r'(AUTOFOLD_(RFD4_(MODEL|EXECUTABLE)|BOLTZGEN_(EXECUTABLE|CACHE)|COMPLEXA_(REPO|PYTHON)|RFANTIBODY_(REPO|PYTHON)|ANTIFOLD_PYTHON|PRODIGY_PYTHON|ESMFOLD2_(FAST_MODEL|MODEL))|PROTO_[A-Z0-9_]+_(STANDALONE_DIR|WEIGHTS_DIR)|ESMCFOLD_CCD_PATH)'
    if not isinstance(env, dict) or any(not re.fullmatch(allowed, k) or not isinstance(v, str) for k,v in env.items()):
        raise ValueError('Runtime environment may contain only model installation paths/settings')
    env = dict(env)
    if rfd4['backend']=='bioir':
        for key in ('executable','model_path'):
            if not Path(rfd4.get(key,'')).is_absolute():
                raise ValueError('BioIR RFD4 requires provisioned executable/model paths')
        env.update(AUTOFOLD_RFD4_EXECUTABLE=rfd4['executable'],AUTOFOLD_RFD4_MODEL=rfd4['model_path'])
    content = (json.dumps(profile, sort_keys=True, indent=2) + '\n').encode()
    lock.parent.mkdir(parents=True, exist_ok=True)
    try:
        with lock.open('xb') as stream:
            stream.write(content)
    except FileExistsError:
        if lock.read_bytes() != content:
            raise ValueError('Campaign runtime profile changed; preserve comparison consistency')
    (directory / 'runtime-profile.json').write_bytes(content)
    child_env = {**env, 'AUTOFOLD_RUNTIME_PROFILE': str(directory / 'runtime-profile.json')}
    if runtime_root.is_dir():
        shutil.copytree(runtime_root, directory / 'runtime', ignore=shutil.ignore_patterns('__pycache__','*.pyc'))
        child_env['AUTOFOLD_BOLTZ2_RUNTIME_HOOK'] = str(directory / 'runtime' / 'boltz_runtime.py')
    elif any(r['backend'] != 'native' for r in (route, af2, rfd4)):
        raise ValueError('Deploy the infrastructure runtime directory beside the trial runner')
    fingerprint = hashlib.sha256(content)
    for source in sorted((directory / 'runtime').rglob('*')):
        if source.is_file() and source.suffix != '.md':
            fingerprint.update(source.relative_to(directory / 'runtime').as_posix().encode())
            fingerprint.update(source.read_bytes())
    child_env['AUTOFOLD_RUNTIME_FINGERPRINT'] = fingerprint.hexdigest()
    fingerprint_lock = lock.with_name('runtime-fingerprint.sha256')
    try:
        with fingerprint_lock.open('x') as stream:
            stream.write(fingerprint.hexdigest())
    except FileExistsError:
        if fingerprint_lock.read_text() != fingerprint.hexdigest():
            raise ValueError('Campaign runtime implementation changed; preserve comparison consistency')
    return child_env, {'sha256': hashlib.sha256(content).hexdigest(), 'path': 'runtime-profile.json'}


def verify_assessments(campaign):
    """Check committed assessments; never silently adopt or repair existing records."""
    campaign = Path(campaign).resolve()
    root = campaign / "output" / "trials"
    report = {"verified": [], "pending": [], "errors": []}
    if not root.exists() and not root.is_symlink():
        return report
    if root.is_symlink() or not root.resolve().is_relative_to(campaign) or not root.is_dir():
        report["errors"].append("Invalid output/trials directory")
        return report
    for directory in sorted(root.glob("t-*")):
        try:
            if directory.is_symlink() or not directory.is_dir():
                raise ValueError("trial directory is not a regular directory")
            assessment = directory / "assessment.md"
            receipt = directory / "assessment.json"
            if not any(p.exists() or p.is_symlink() for p in (assessment, receipt)):
                report["pending"].append(directory.name)
                continue
            if any(p.is_symlink() or not p.is_file() for p in (assessment, receipt)):
                raise ValueError("assessment.md and assessment.json must both be regular files; uncommitted or incomplete assessment")
            record = json.loads(receipt.read_text())
            if (not isinstance(record, dict) or record.get("schema_version") != 1
                    or record.get("trial_id") != directory.name or not record.get("committed_at")):
                raise ValueError("invalid assessment receipt")
            if digest(assessment) != record.get("sha256"):
                raise ValueError("assessment.md hash mismatch")
            report["verified"].append(directory.name)
        except (OSError, ValueError) as error:
            report["errors"].append(f"{directory.name}: {error}")
    return report


def require_assessment_integrity(campaign):
    report = verify_assessments(campaign)
    if report["errors"]:
        raise ValueError("Assessment integrity failure: " + "; ".join(report["errors"]))
    return report


def commit_assessment(campaign, trial, draft):
    """Publish exact draft bytes once. Corrections belong in the mutable notebook."""
    campaign = Path(campaign).resolve()
    require_assessment_integrity(campaign)
    directory = (campaign / relative_path(trial)).resolve()
    if (directory.parent != campaign / "output" / "trials" or not directory.name.startswith("t-")
            or not directory.is_dir()):
        raise ValueError("Trial must be an existing output/trials/t-* directory")
    status = json.loads((directory / "execution.json").read_text())
    if (status.get("state") not in ("completed", "failed", "interrupted") or not status.get("ended_at")
            or not (directory / "trial.json").is_file()):
        raise ValueError("Inspect a terminal execution before committing an assessment")
    source = contained_file(campaign, draft)
    if source.is_relative_to(campaign / "output" / "trials"):
        raise ValueError("Keep the editable assessment draft outside captured trials")
    content = source.read_bytes()
    if not content.decode("utf-8").strip():
        raise ValueError("Assessment draft must contain nonempty UTF-8 text")
    assessment = directory / "assessment.md"
    receipt = directory / "assessment.json"
    if any(p.exists() or p.is_symlink() for p in (assessment, receipt)):
        raise ValueError("Assessment already recorded; add a dated notebook correction with evidence links")
    record = {"schema_version": 1, "trial_id": directory.name, "committed_at": now(),
              "sha256": hashlib.sha256(content).hexdigest()}
    # Exclusive receipt creation arbitrates concurrent commits. An interrupted pair
    # stays visible as an integrity failure, rather than being silently overwritten.
    for path, data in ((receipt, (json.dumps(record, indent=2) + "\n").encode()), (assessment, content)):
        with path.open("xb") as stream:
            os.fchmod(stream.fileno(), 0o444)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    return record


def prepare_trial(campaign):
    """Allocate the permanent address before the scientist writes its plan."""
    campaign = Path(campaign).resolve()
    if not (campaign / "campaign.md").is_file():
        raise ValueError("Missing campaign.md")
    require_assessment_integrity(campaign)
    directory = campaign / "output" / "trials" / ("t-" + uuid.uuid4().hex[:12])
    directory.mkdir(parents=True, exist_ok=False)
    write_json(directory / "execution.json", {
        "state": "prepared", "started_at": None, "ended_at": None,
        "exit_code": None, "error": None, "host": socket.gethostname(),
        "runner_pid": None, "process_pid": None,
    })
    return directory


def run_trial(campaign, program, inputs, command, intent, evaluation=None, timeout=300, *, trial=None):
    campaign = Path(campaign).resolve()
    require_assessment_integrity(campaign)
    if trial is None:
        raise ValueError("Prepare a trial and write its plan.md before execution; supply --trial")
    directory = (campaign / relative_path(trial)).resolve()
    trials_root = campaign / "output" / "trials"
    if directory.parent != trials_root or not directory.name.startswith("t-") or not directory.is_dir():
        raise ValueError("Trial must be a prepared output/trials/t-* directory")
    status = json.loads((directory / "execution.json").read_text())
    if status["state"] != "prepared" or (directory / "trial.json").exists():
        raise ValueError("Trial already attempted; prepare a new trial")
    plan = directory / "plan.md"
    if plan.is_symlink() or not plan.is_file() or not plan.read_text().strip():
        raise ValueError("Write a nonempty trial plan.md before execution")
    if {p.name for p in directory.iterdir()} - {"execution.json", "plan.md"}:
        raise ValueError("Prepared trial must contain only execution.json and plan.md before capture")
    program = (campaign / relative_path(program)).resolve()
    if not program.is_relative_to(campaign) or not program.is_dir():
        raise ValueError("Program must be a directory inside the campaign")
    if program.is_relative_to(trials_root):
        raise ValueError("Use an editable program bundle outside captured trials")
    if not (campaign / "campaign.md").is_file():
        raise ValueError("Missing campaign.md")
    if not command or timeout <= 0:
        raise ValueError("Supply a command and a positive timeout")
    executable = shutil.which(command[0])
    if executable is None:
        raise ValueError(f"Executable not found: {command[0]}")
    command = [os.path.abspath(executable), *command[1:]]
    source_files = []
    for source in sorted(program.rglob("*")):
        if source.is_symlink():
            raise ValueError(f"Program bundle cannot contain symlinks: {source}")
        if source.is_file() and "__pycache__" not in source.parts:
            source_files.append(source)
    captured_inputs = []
    destinations = set()
    for declaration in inputs:
        destination, source = declaration.split("=", 1)
        destination = relative_path(destination)
        if destination.as_posix() in destinations:
            raise ValueError(f"Duplicate input destination: {destination}")
        destinations.add(destination.as_posix())
        captured_inputs.append((destination, contained_file(campaign, source), source))

    process = None
    snapshots = []
    try:
        brief_bytes = (campaign / "campaign.md").read_bytes()
        brief = brief_bytes.decode("utf-8")
        # Quote the launch text: relocating its original relative links must not
        # turn them into broken canonical evidence links. plan.md owns citations.
        fence = "`" * max(3, max((len(m.group()) + 1 for m in re.finditer(r"`+", brief)), default=3))
        (directory / "brief.md").write_text(
            "# Campaign brief at launch\n\nVerbatim campaign.md; source-relative links below are quoted text.\n\n"
            + fence + "markdown\n" + brief + ("" if brief.endswith("\n") else "\n") + fence + "\n")
        (directory / "program").mkdir()
        for source in source_files:
            target = directory / "program" / source.relative_to(program)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        runtime_env, runtime_receipt = capture_runtime(campaign, directory)
        records = []
        for destination, source, original in captured_inputs:
            target = directory / "inputs" / destination
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            records.append({"source": original, "path": target.relative_to(directory).as_posix(),
                            "sha256": digest(target)})
        (directory / "inputs").mkdir(exist_ok=True)
        snapshots = [{"path": item.relative_to(directory).as_posix(), "sha256": digest(item)}
                     for item in sorted(directory.rglob("*")) if item.is_file()
                     and item.name != "execution.json"]
        manifest = {"schema_version": 2, "id": directory.name, "created_at": now(), "intent": intent,
                    "plan": "plan.md", "brief": "brief.md", "brief_source_sha256": hashlib.sha256(brief_bytes).hexdigest(), "cwd": ".",
                    "program_source": program.relative_to(campaign).as_posix(),
                    "evaluation": evaluation, "command": command, "inputs": records,
                    "snapshot": snapshots, "environment": environment(), "runtime_profile": runtime_receipt,
                    "timeout_seconds": timeout}
        write_json(directory / "trial.json", manifest)
        (directory / "output").mkdir()
        print(json.dumps({"trial_id": directory.name, "directory": str(directory)}), flush=True)
        with (directory / "stdout.log").open("wb") as stdout, (directory / "stderr.log").open("wb") as stderr:
            try:
                child_env = {**os.environ, **runtime_env, "PYTHONDONTWRITEBYTECODE": "1"}
                process = subprocess.Popen(command, cwd=directory, stdout=stdout, stderr=stderr,
                                           env=child_env, start_new_session=True)
                status.update(state="running", started_at=now(), runner_pid=os.getpid(), process_pid=process.pid)
                write_json(directory / "execution.json", status)
                status["exit_code"] = process.wait(timeout=timeout)
                status["state"] = "completed" if process.returncode == 0 else "failed"
            except (subprocess.TimeoutExpired, KeyboardInterrupt) as error:
                if process is not None:
                    stop_process(process)
                    status["exit_code"] = process.returncode
                status.update(state="interrupted", error=type(error).__name__)
    except Exception as error:
        if process is not None and process.poll() is None:
            stop_process(process)
        status.update(state="failed", error=f"{type(error).__name__}: {error}")
    artifacts = []
    capture_errors = []
    # Inventory final output and logs, including rejected/partial work that was saved.
    for item in sorted(directory.rglob("*")):
        relative = item.relative_to(directory)
        if relative.parts[0] != "output" and relative.as_posix() not in ("stdout.log", "stderr.log"):
            continue
        if item.is_symlink():
            capture_errors.append(f"Artifact is a symlink: {relative}")
        elif item.is_file():
            artifacts.append({"path": relative.as_posix(), "sha256": digest(item)})
    for item in snapshots:
        path = directory / item["path"]
        if path.is_symlink() or not path.is_file() or digest(path) != item["sha256"]:
            capture_errors.append(f"Captured file changed during execution: {item['path']}")
    capture_errors.extend(verify_assessments(campaign)["errors"])
    if capture_errors:
        if status["state"] == "completed":
            status["state"] = "failed"
        status["capture_errors"] = capture_errors
    status.update(ended_at=now(), artifacts=artifacts)
    write_json(directory / "execution.json", status)
    print(json.dumps({"trial_id": directory.name, **status}), flush=True)
    return directory, status


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--campaign", required=True)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--prepare", action="store_true", help="Allocate a trial; write its plan.md before execution")
    mode.add_argument("--assess", metavar="DRAFT", help="Commit a campaign-relative UTF-8 assessment draft once")
    mode.add_argument("--verify-assessments", action="store_true", help="Verify assessment hashes before handoff")
    parser.add_argument("--trial", help="Prepared campaign-relative output/trials/t-* directory")
    parser.add_argument("--program", help="Campaign-relative source directory")
    parser.add_argument("--input", action="append", default=[], help="Destination inside inputs/=campaign-relative source")
    parser.add_argument("--intent")
    parser.add_argument("--evaluation")
    parser.add_argument("--timeout", type=float, default=300)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.verify_assessments:
        if args.trial or args.program or args.command or args.input or args.intent or args.evaluation:
            parser.error("--verify-assessments only checks existing assessment records")
        report = verify_assessments(args.campaign)
        print(json.dumps(report))
        return 1 if report["errors"] else 0
    if args.assess:
        if not args.trial or args.program or args.command or args.input or args.intent or args.evaluation:
            parser.error("--assess requires --trial and a draft, without execution arguments")
        try:
            print(json.dumps(commit_assessment(args.campaign, args.trial, args.assess)))
        except (OSError, ValueError) as error:
            print(f"Assessment commit failed: {error}", file=sys.stderr)
            return 1
        return 0
    if args.prepare:
        if args.trial or args.program or args.command:
            parser.error("--prepare only allocates; do not supply a trial, program or command")
        directory = prepare_trial(args.campaign)
        print(json.dumps({"trial_id": directory.name, "directory": str(directory)}))
        return 0
    if not args.trial or not args.program or not args.intent:
        parser.error("execution requires --trial, --program and --intent")
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    _, status = run_trial(args.campaign, args.program, args.input, command,
                          args.intent, args.evaluation, args.timeout, trial=args.trial)
    return 0 if status["state"] == "completed" else 1


if __name__ == "__main__":
    sys.exit(main())
