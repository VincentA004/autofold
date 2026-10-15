"""Execute one trusted worker stage in a disposable Python process.

Native Proto tools can initialize thread pools and accelerator runtimes with
process-global state. Keeping generation and evidence in separate processes
prevents one tool family from contaminating the next while leaving all frozen
scientific sources and contracts unchanged.
"""

from __future__ import annotations

import argparse
import faulthandler
import os
import sys
from pathlib import Path

from .runtime import configure_headless

configure_headless()

from .adapters import ProtoDesignAdapter
from .cli import load_evidence_adapter
from .protocol import ProtocolError, read_json, write_json
from .native_search import NativeExecutionStopped


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description="Run one isolated Autofold worker stage")
    value.add_argument("--stage", required=True, choices=("generation", "evidence"))
    value.add_argument("--runtime-bundle", required=True, type=Path)
    value.add_argument("--output", required=True, type=Path)
    value.add_argument("--result", required=True, type=Path)
    value.add_argument("--candidate-set", type=Path)
    value.add_argument("--evidence-adapter-source", type=Path)
    return value


def run(args: argparse.Namespace) -> None:
    bundle = read_json(args.runtime_bundle)
    if bundle.get("nativeExecution") is not None:
        from .adapters.proto import _prepare_runtime
        from .cli import _validate_worker_tree
        from .protocol import validate_native_execution
        from .native_lifecycle import native_api
        validate_native_execution(bundle)
        _validate_worker_tree(bundle)
        native_api(_prepare_runtime(bundle))
    if args.stage == "generation":
        result = ProtoDesignAdapter().generate(bundle, args.output)
    else:
        if args.candidate_set is None or args.evidence_adapter_source is None:
            raise ProtocolError("Evidence stage requires a candidate set and frozen adapter source")
        enrich = load_evidence_adapter(args.evidence_adapter_source)
        result = enrich(bundle, read_json(args.candidate_set), args.output)
    write_json(args.result, result)


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    # Persist periodic Python stacks beside the isolated result. Native model
    # setup and registry code can block without a child process or artifact;
    # this watchdog makes that state diagnosable without changing the frozen
    # evaluator/evidence-adapter source or interrupting a legitimate long call.
    stack_path = args.result.with_name(f"{args.stage}-stack.log")
    stack_path.parent.mkdir(parents=True, exist_ok=True)
    stack_file = stack_path.open("a", encoding="utf-8")
    faulthandler.dump_traceback_later(120, repeat=True, file=stack_file)
    try:
        run(args)
    # A model/plugin boundary can fail with many ordinary exception types
    # (ImportError for an authored symbol, RuntimeError for an empty generator
    # result, subprocess errors from a model CLI, pydantic validation errors,
    # and so on).  Preserve every non-control-flow exception so the parent
    # process, knowledge closeout, and next scientist iteration receive the
    # actual diagnostic instead of an opaque exit code.
    except BaseException as error:
        native_control = ()
        try:
            from proto_tools.utils.execution_observer import ExecutionCancelled, ObservationPublicationError
            native_control = (ExecutionCancelled, ObservationPublicationError)
        except ImportError:
            pass
        if not isinstance(error, (Exception, NativeExecutionStopped, *native_control)):
            raise
        write_json(
            args.result.with_suffix(".error.json"),
            {"errorType": type(error).__name__, "error": str(error)},
        )
        print(str(error), file=sys.stderr, flush=True)
        return 2
    finally:
        faulthandler.cancel_dump_traceback_later()
        stack_file.close()
    return 0


if __name__ == "__main__":
    code = main()
    # Some Proto/model runtimes retain non-daemon threads after returning.
    # Artifacts are already atomically persisted, so the disposable stage must
    # not hang during interpreter teardown.
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(code)
